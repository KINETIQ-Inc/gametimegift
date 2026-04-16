-- =============================================================================
-- Migration: 20260305000007_create_order_lines
--
-- Creates:
--   type  public.order_line_status       enum for per-line lifecycle
--   table public.order_lines             one-unit-per-line order detail records
--   RLS   order_lines                    mirrors orders (admin all; own)
-- =============================================================================

-- ─── Enum: order_line_status ──────────────────────────────────────────────────
-- Per-line lifecycle, independent of the parent order's status.
-- Enables partial fulfillment and partial returns at line granularity.
--
-- SYNC REQUIREMENT: values must match @gtg/types OrderLineStatus exactly.

create type public.order_line_status as enum (
  'reserved',   -- SerializedUnit held; awaiting shipment
  'shipped',    -- Carrier has the unit; not yet confirmed delivered
  'delivered',  -- Delivery confirmed
  'returned',   -- Unit returned; triggers commission reversal
  'cancelled'   -- Line removed before shipment; unit released to available
);

-- ─── Table: order_lines ───────────────────────────────────────────────────────
-- One row per serialized unit within an order.
-- There is no quantity > 1 per line — every physical unit has its own line,
-- its own serial number, and its own commission and royalty obligations.
--
-- Denormalization contract:
--   At line creation, serial_number, sku, product_name, license_body,
--   royalty_rate, royalty_cents, retail_price_cents, commission_tier,
--   commission_rate, and commission_cents are stamped from the unit record.
--   They do not change if the product price or consultant tier changes later.
--
-- Commission fields consistency:
--   commission_tier, commission_rate, and commission_cents are either all
--   null (no consultant) or all non-null (consultant-assisted sale).
--   Enforced by a check constraint below.
--
-- Return consistency:
--   returned_at requires return_reason. Both are null unless line is returned.
--   Enforced by a check constraint.
--
-- Compliance contract:
--   Hard delete is prohibited. Cancel with status = 'cancelled'.

create table public.order_lines (
  -- Identity
  id                    uuid                      not null  default gen_random_uuid(),
  order_id              uuid                      not null  references public.orders (id),
  -- 1-indexed line number within the order. Stable after creation.
  line_number           integer                   not null,

  -- Lifecycle
  status                public.order_line_status  not null  default 'reserved',

  -- Unit linkage
  unit_id               uuid                      not null  references public.serialized_units (id),

  -- Denormalized unit fields (stamped at line creation)
  serial_number         text                      not null,
  sku                   text                      not null,
  product_name          text                      not null,
  license_body          public.license_body       not null,
  royalty_rate          numeric(5, 4)             not null,
  -- royalty_cents = retail_price_cents × royalty_rate (rounded to nearest cent).
  royalty_cents         integer                   not null,
  -- Retail price captured at line creation. Immutable.
  retail_price_cents    integer                   not null,

  -- Commission (all three are null together or non-null together)
  commission_tier       public.commission_tier,
  commission_rate       numeric(5, 4),
  commission_cents      integer,

  -- Commission entry linkage (populated after payment is confirmed)
  -- No FK here — commission_entries is created in a later migration.
  commission_entry_id   uuid,

  -- Shipment tracking
  carrier               text,
  tracking_number       text,
  shipped_at            timestamptz,
  delivered_at          timestamptz,

  -- Return
  returned_at           timestamptz,
  return_reason         text,

  -- Audit
  created_at            timestamptz               not null  default now(),
  updated_at            timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint order_lines_pkey
    primary key (id),

  -- Line number must be positive (1-indexed).
  constraint order_lines_line_number_positive
    check (line_number >= 1),

  -- One unit may appear on at most one active line.
  -- Prevents double-selling the same physical unit.
  constraint order_lines_unit_unique
    unique (unit_id),

  -- (order_id, line_number) must be unique within an order.
  constraint order_lines_order_line_number_unique
    unique (order_id, line_number),

  constraint order_lines_royalty_rate_valid
    check (royalty_rate > 0 and royalty_rate <= 1),

  constraint order_lines_retail_price_positive
    check (retail_price_cents > 0),

  constraint order_lines_royalty_cents_nonneg
    check (royalty_cents >= 0),

  -- Commission fields must be all-null or all-non-null.
  constraint order_lines_commission_fields_consistent
    check (
      (commission_tier is null and commission_rate is null and commission_cents is null)
      or
      (commission_tier is not null and commission_rate is not null and commission_cents is not null)
    ),

  constraint order_lines_commission_rate_valid
    check (
      commission_rate is null
      or (commission_rate > 0 and commission_rate <= 1)
    ),

  constraint order_lines_commission_cents_nonneg
    check (commission_cents is null or commission_cents >= 0),

  -- Return consistency: returned_at requires return_reason.
  constraint order_lines_return_consistent
    check (
      returned_at is null
      or (returned_at is not null and return_reason is not null)
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger order_lines_set_updated_at
  before update on public.order_lines
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on unit_id creates an index (fast unit → line lookup).
-- Unique constraint on (order_id, line_number) creates a composite index.

create index order_lines_order_id_idx
  on public.order_lines (order_id);

create index order_lines_status_idx
  on public.order_lines (status);

-- Shipped but not delivered: carrier tracking follow-up queries.
create index order_lines_shipped_undelivered_idx
  on public.order_lines (shipped_at desc)
  where status = 'shipped';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.order_lines enable row level security;

-- SELECT: admin reads all lines.
create policy "order_lines_select_admin"
  on public.order_lines
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: consultants see lines on orders they facilitated.
create policy "order_lines_select_consultant_own"
  on public.order_lines
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

-- SELECT: customers see lines on their own orders.
create policy "order_lines_select_customer_own"
  on public.order_lines
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
create policy "order_lines_insert_admin"
  on public.order_lines
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status transitions, tracking, commission_entry_id.
create policy "order_lines_update_admin"
  on public.order_lines
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.order_lines is
  'One row per serialized unit within an order. No quantity > 1 per line — '
  'every physical unit has its own line with its own serial number, royalty '
  'obligation, and commission record.';

comment on column public.order_lines.royalty_cents is
  'Royalty amount for this line: retail_price_cents × royalty_rate, '
  'rounded to the nearest cent. Computed and stamped at line creation.';

comment on column public.order_lines.commission_entry_id is
  'FK → commission_entries.id. Populated when the commission record is '
  'created after payment is confirmed. No FK constraint defined here — '
  'added in the commission_entries migration.';
