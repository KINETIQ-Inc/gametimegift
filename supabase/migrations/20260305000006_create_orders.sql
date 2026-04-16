-- =============================================================================
-- Migration: 20260305000006_create_orders
--
-- Creates:
--   type  public.order_status            enum for order lifecycle
--   type  public.payment_method          enum for payment instrument
--   type  public.fulfillment_channel     enum for order origin channel
--   table public.orders                  customer purchase records
--   RLS   orders                         admin all; consultant/customer own
--   alter public.serialized_units        adds order_id FK constraint
-- =============================================================================

-- ─── Enum: order_status ───────────────────────────────────────────────────────
-- Lifecycle of a customer order from draft through fulfillment and closure.
--
-- SYNC REQUIREMENT: values must match @gtg/types OrderStatus exactly.

create type public.order_status as enum (
  'draft',              -- Being assembled; no payment attempted
  'pending_payment',    -- Payment initiated; awaiting confirmation
  'payment_failed',     -- Payment declined or errored; may retry
  'paid',               -- Payment confirmed; units not yet shipped
  'fulfilling',         -- At least one unit shipped; remainder pending
  'fulfilled',          -- All units shipped and confirmed delivered
  'partially_returned', -- Subset of units returned; order otherwise closed
  'fully_returned',     -- All units returned
  'refunded',           -- Payment refunded in full (no units shipped)
  'cancelled'           -- Voided before payment capture
);

-- ─── Enum: payment_method ─────────────────────────────────────────────────────
-- Payment instrument used to settle an order.
--
-- SYNC REQUIREMENT: values must match @gtg/types PaymentMethod exactly.

create type public.payment_method as enum (
  'card',       -- Credit or debit card (Stripe)
  'ach',        -- ACH bank transfer
  'gift_card',  -- GTG gift card balance
  'manual'      -- Admin-entered payment (check, wire, comp)
);

-- ─── Enum: fulfillment_channel ────────────────────────────────────────────────
-- How the order was placed. Determines consultant attribution and
-- commission eligibility.
--
-- SYNC REQUIREMENT: values must match @gtg/types FulfillmentChannel exactly.

create type public.fulfillment_channel as enum (
  'storefront_direct',   -- Customer self-service; no consultant
  'consultant_assisted', -- Consultant placed or facilitated the order
  'admin'                -- Placed by an admin (test, replacement, comp)
);

-- ─── Table: orders ────────────────────────────────────────────────────────────
-- Top-level financial and fulfillment record for a customer purchase.
-- An order contains one or more order_lines, each representing one
-- serialized unit.
--
-- Financial contract:
--   total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents
--   This invariant is enforced by a check constraint.
--   All amounts are non-negative; discount_cents must not exceed subtotal.
--
-- Consultant attribution:
--   If channel = 'consultant_assisted', consultant_id and consultant_name
--   must be populated. They are null for 'storefront_direct' and 'admin'.
--
-- Compliance contract:
--   - order_number is immutable after creation (enforced by trigger).
--   - Hard delete is prohibited.

create table public.orders (
  -- Identity
  id                    uuid                        not null  default gen_random_uuid(),
  -- Human-readable order number shown to customers and consultants.
  -- Format: GTG-YYYYMMDD-XXXXXX (zero-padded sequential suffix per day).
  -- Immutable after creation.
  order_number          text                        not null,

  -- Lifecycle
  status                public.order_status         not null  default 'draft',
  channel               public.fulfillment_channel  not null,

  -- Customer
  -- Null for guest checkouts.
  customer_id           uuid                        references auth.users (id),
  customer_name         text                        not null,
  customer_email        text                        not null,

  -- Consultant (null when channel != 'consultant_assisted')
  -- References consultant_profiles.id, not auth.users.id.
  consultant_id         uuid                        references public.consultant_profiles (id),
  consultant_name       text,

  -- Shipping
  -- ShippingAddress stored as JSONB. Required at order creation.
  shipping_address      jsonb                       not null,

  -- Payment
  payment_method        public.payment_method       not null,
  -- Stripe PaymentIntent ID or equivalent. Null until payment initiated.
  payment_intent_id     text,
  -- Stripe charge ID. Null until payment captured.
  charge_id             text,

  -- Financials (all in cents, USD)
  subtotal_cents        integer                     not null,
  discount_cents        integer                     not null  default 0,
  shipping_cents        integer                     not null  default 0,
  tax_cents             integer                     not null  default 0,
  total_cents           integer                     not null,
  -- Cumulative amount refunded. 0 until a refund is issued.
  refunded_cents        integer                     not null  default 0,

  -- Discount
  discount_code         text,

  -- Internal
  internal_notes        text,

  -- Timestamps
  created_at            timestamptz                 not null  default now(),
  paid_at               timestamptz,
  fulfilled_at          timestamptz,
  closed_at             timestamptz,
  updated_at            timestamptz                 not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint orders_pkey
    primary key (id),

  constraint orders_order_number_unique
    unique (order_number),

  -- Order number format: GTG-YYYYMMDD-XXXXXX
  constraint orders_order_number_format
    check (order_number ~ '^GTG-[0-9]{8}-[0-9]{6}$'),

  -- Financial integrity: total must equal the sum of its parts.
  constraint orders_total_correct
    check (total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents),

  constraint orders_subtotal_nonneg
    check (subtotal_cents >= 0),

  constraint orders_discount_nonneg
    check (discount_cents >= 0),

  -- Discount cannot exceed subtotal (no negative gross margin at order level).
  constraint orders_discount_not_excess
    check (discount_cents <= subtotal_cents),

  constraint orders_shipping_nonneg
    check (shipping_cents >= 0),

  constraint orders_tax_nonneg
    check (tax_cents >= 0),

  constraint orders_total_nonneg
    check (total_cents >= 0),

  constraint orders_refunded_nonneg
    check (refunded_cents >= 0),

  -- Cannot refund more than the original total.
  constraint orders_refunded_not_excess
    check (refunded_cents <= total_cents),

  -- Consultant attribution consistency:
  -- 'consultant_assisted' orders must identify the consultant.
  -- 'storefront_direct' and 'admin' orders must not.
  constraint orders_consultant_channel_consistent
    check (
      (channel = 'consultant_assisted' and consultant_id is not null and consultant_name is not null)
      or
      (channel != 'consultant_assisted' and consultant_id is null and consultant_name is null)
    ),

  constraint orders_customer_email_format
    check (customer_email like '%@%')
);

-- ─── Order Number Immutability Trigger ────────────────────────────────────────
-- order_number appears on packing slips and customer receipts.
-- It cannot change after the order is created.

create or replace function public.prevent_order_number_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.order_number is distinct from new.order_number then
    raise exception
      '[GTG] Order order_number is immutable. Cannot change ''%'' to ''%''. '
      'The order number is printed on customer receipts and packing slips.',
      old.order_number, new.order_number;
  end if;
  return new;
end;
$$;

create trigger orders_immutable_order_number
  before update on public.orders
  for each row
  execute function public.prevent_order_number_update();

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on order_number already creates a B-tree index.

create index orders_status_idx
  on public.orders (status);

-- Customer → orders lookup.
create index orders_customer_id_idx
  on public.orders (customer_id)
  where customer_id is not null;

-- Consultant → orders lookup (for commission and sales reporting).
create index orders_consultant_id_idx
  on public.orders (consultant_id)
  where consultant_id is not null;

-- Time-series queries (revenue reports, period summaries).
create index orders_created_at_idx
  on public.orders (created_at desc);

-- Paid orders by date — primary input for royalty period calculations.
create index orders_paid_at_idx
  on public.orders (paid_at desc)
  where paid_at is not null;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.orders enable row level security;

-- SELECT: admin reads all orders.
create policy "orders_select_admin"
  on public.orders
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: consultants see orders they facilitated.
-- Looks up the consultant profile by auth.uid() to resolve the profile id.
create policy "orders_select_consultant_own"
  on public.orders
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and consultant_id in (
      select id from public.consultant_profiles
      where auth_user_id = auth.uid()
    )
  );

-- SELECT: customers see their own orders.
create policy "orders_select_customer_own"
  on public.orders
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
    and customer_id = auth.uid()
  );

-- INSERT: admin only. Orders are created by admin or service functions.
create policy "orders_insert_admin"
  on public.orders
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status transitions, payment capture, refunds.
create policy "orders_update_admin"
  on public.orders
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Close orders with status = 'cancelled' or 'refunded'.

-- ─── Deferred FK: serialized_units.order_id ──────────────────────────────────
-- This FK was deferred at serialized_units creation to avoid a forward reference.
-- orders now exists; the constraint is safe to add.

alter table public.serialized_units
  add constraint serialized_units_order_id_fkey
    foreign key (order_id) references public.orders (id);

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.orders is
  'Customer purchase records. Each order holds financial totals and links to '
  'one or more order_lines (one per serialized unit). The order is the unit '
  'of payment processing and customer-facing fulfillment tracking.';

comment on column public.orders.order_number is
  'Immutable human-readable identifier. Format: GTG-YYYYMMDD-XXXXXX. '
  'Printed on receipts and packing slips. Cannot change after creation.';

comment on column public.orders.shipping_address is
  'ShippingAddress snapshot stored as JSONB at order creation. '
  'Preserved even if the customer later changes their address on file.';

comment on column public.orders.total_cents is
  'Amount charged to the customer: subtotal - discount + shipping + tax. '
  'Enforced by check constraint. This is the amount submitted to the gateway.';

comment on column public.orders.refunded_cents is
  'Cumulative amount refunded in cents. 0 until a refund is issued. '
  'Partial refunds are supported; refunded_cents ≤ total_cents enforced.';
