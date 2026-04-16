-- =============================================================================
-- Migration: 20260305000013_create_order_line_items
--
-- Creates:
--   type  public.order_line_item_type    enum for non-unit charge categories
--   table public.order_line_items        itemized non-unit charges on an order
--   RLS   order_line_items               mirrors orders (admin all; own)
--
-- Relationship to order_lines:
--   order_lines      — one row per serialized unit (physical product)
--   order_line_items — one row per non-unit charge/credit (shipping, tax,
--                      discount, fee, adjustment)
--
-- Both tables contribute to the full invoice view for an order.
-- The order-level aggregate columns (discount_cents, shipping_cents, tax_cents,
-- total_cents) on the orders table remain the authoritative financial figures
-- for payment processing. order_line_items provides the itemized detail for
-- invoice rendering, partial refund attribution, and tax jurisdiction breakdown.
-- =============================================================================

-- ─── Enum: order_line_item_type ───────────────────────────────────────────────
-- Category of a non-unit charge or credit on an order.
--
-- Amount sign convention:
--   shipping, tax, fee   → amount_cents > 0  (charges to the customer)
--   discount             → amount_cents < 0  (credit to the customer)
--   adjustment           → amount_cents ≠ 0  (positive debit or negative credit)
--
-- SYNC REQUIREMENT: if values change, update @gtg/types accordingly.

create type public.order_line_item_type as enum (
  'shipping',    -- Carrier shipping charge (e.g. USPS Priority Mail)
  'tax',         -- Tax collected (one row per jurisdiction if multiple)
  'discount',    -- Discount or promotional credit applied (negative amount)
  'fee',         -- Processing, handling, rush, or other service fee
  'adjustment'   -- Manual admin debit or credit
);

-- ─── Table: order_line_items ──────────────────────────────────────────────────
-- Itemized non-unit charges and credits on an order.
-- Every item that appears on the customer invoice but is not a serialized
-- physical unit belongs here: shipping tiers, tax jurisdictions, coupon
-- codes, gift wrapping fees, manual admin credits.
--
-- Amount sign contract:
--   'shipping', 'tax', 'fee'  → amount_cents must be > 0.
--   'discount'                → amount_cents must be < 0.
--   'adjustment'              → amount_cents may be positive (debit) or
--                               negative (credit), but not zero.
--   These invariants are enforced by constraint below.
--
-- Immutability contract:
--   Hard delete is prohibited. Void/reverse adjustments by inserting a new
--   offsetting row with a description referencing the original line number.
--
-- Relationship to orders aggregate columns:
--   orders.shipping_cents  = SUM(amount_cents) WHERE type = 'shipping'
--   orders.tax_cents       = SUM(amount_cents) WHERE type = 'tax'
--   orders.discount_cents  = ABS(SUM(amount_cents)) WHERE type = 'discount'
--   The application layer is responsible for keeping these in sync.

create table public.order_line_items (
  -- Identity
  id              uuid                          not null  default gen_random_uuid(),
  order_id        uuid                          not null  references public.orders (id),
  -- Display ordering on the invoice. 1-indexed. Does not need to be contiguous.
  line_number     integer                       not null,

  -- Classification
  type            public.order_line_item_type   not null,

  -- Description shown on invoice (e.g. "USPS Priority Mail", "CA Sales Tax 9.5%",
  -- "Promo Code SAVE10", "Rush Processing Fee", "Admin Credit — duplicate charge").
  description     text                          not null,

  -- Amount in cents (USD). Negative for discounts; see sign contract above.
  amount_cents    integer                       not null,

  -- External reference (e.g. tax provider calc ID, carrier rate quote ID,
  -- discount code string, Stripe fee ID). Null when not applicable.
  reference_id    text,

  -- Audit
  created_at      timestamptz                   not null  default now(),
  updated_at      timestamptz                   not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint order_line_items_pkey
    primary key (id),

  constraint order_line_items_line_number_positive
    check (line_number >= 1),

  -- (order_id, line_number) must be unique per order for stable invoice display.
  constraint order_line_items_order_line_unique
    unique (order_id, line_number),

  -- Amount must be non-zero for all types.
  constraint order_line_items_amount_nonzero
    check (amount_cents != 0),

  -- Charges (shipping, tax, fee) must be positive.
  constraint order_line_items_charge_positive
    check (
      type not in ('shipping', 'tax', 'fee')
      or amount_cents > 0
    ),

  -- Discounts must be negative (they reduce the customer's total).
  constraint order_line_items_discount_negative
    check (
      type != 'discount'
      or amount_cents < 0
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger order_line_items_set_updated_at
  before update on public.order_line_items
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Primary query: all non-unit charges for a given order, in display order.
create index order_line_items_order_id_idx
  on public.order_line_items (order_id, line_number asc);

-- Type filter: sum shipping or tax items across orders for period reporting.
create index order_line_items_type_idx
  on public.order_line_items (type);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.order_line_items enable row level security;

-- SELECT: admin reads all items.
create policy "order_line_items_select_admin"
  on public.order_line_items
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: consultants see line items on orders they facilitated.
create policy "order_line_items_select_consultant_own"
  on public.order_line_items
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and order_id in (
      select o.id from public.orders o
      join public.consultant_profiles cp on cp.id = o.consultant_id
      where cp.auth_user_id = auth.uid()
    )
  );

-- SELECT: customers see line items on their own orders.
create policy "order_line_items_select_customer_own"
  on public.order_line_items
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
    and order_id in (
      select id from public.orders
      where customer_id = auth.uid()
    )
  );

-- INSERT: admin only.
create policy "order_line_items_insert_admin"
  on public.order_line_items
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Description and reference_id corrections only.
-- Amount and type changes require a voiding adjustment row instead.
create policy "order_line_items_update_admin"
  on public.order_line_items
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Insert an offsetting adjustment row to reverse.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.order_line_items is
  'Itemized non-unit charges and credits on an order. Each row represents one '
  'invoice line that is not a physical serialized unit: shipping tiers, tax '
  'jurisdictions, discount codes, processing fees, manual admin adjustments. '
  'Hard delete prohibited — reverse by inserting an offsetting adjustment row.';

comment on column public.order_line_items.line_number is
  'Display ordering on the invoice. 1-indexed. Does not need to be contiguous. '
  'Together with order_id, forms a unique key for stable invoice rendering.';

comment on column public.order_line_items.amount_cents is
  'Signed amount in cents (USD). Positive = charge to customer. '
  'Negative = credit to customer. Discounts must be negative. '
  'Shipping, tax, and fees must be positive. Adjustments may be either.';

comment on column public.order_line_items.reference_id is
  'External reference for this line: tax provider calculation ID, carrier rate '
  'quote ID, discount code string, or Stripe fee ID. Null when not applicable.';
