-- =============================================================================
-- Migration: 20260305000002_create_serialized_units
--
-- Creates:
--   type  public.unit_status              enum for physical unit lifecycle
--   func  public.prevent_unit_key_update() immutability guard (serial_number, sku)
--   table public.serialized_units          physical inventory units
--   RLS   serialized_units                admin write; scoped read by role
-- =============================================================================

-- ─── Enum: unit_status ────────────────────────────────────────────────────────
-- Tracks the lifecycle state of a single physical serialized unit.
-- Transitions are enforced by the domain layer (not by SQL), but the enum
-- guarantees only valid states can be stored.
--
-- State semantics:
--   available    — in stock, not reserved or assigned to any order
--   reserved     — temporarily held (e.g. during checkout session); not yet sold
--   sold         — ownership transferred; order_id and sold_at are populated
--   fraud_locked — unit is under investigation; cannot be sold or returned
--   returned     — unit returned by customer; may be restocked or written off
--   voided       — unit removed from inventory permanently (damage, loss, audit)
--
-- SYNC REQUIREMENT: values must match @gtg/types UnitStatus exactly.
-- Adding a value requires both a SQL ALTER TYPE and a TypeScript union update.

create type public.unit_status as enum (
  'available',
  'reserved',
  'sold',
  'fraud_locked',
  'returned',
  'voided'
);

-- ─── Table: serialized_units ──────────────────────────────────────────────────
-- One row per physical serialized item. Each unit is a unique, traceable
-- instance of a product, identified by its serial_number.
--
-- Denormalization contract:
--   At receive time, sku, product_name, license_body, royalty_rate, and
--   cost_cents are copied from the products row and stamped onto the unit.
--   They are NEVER retroactively updated — historical cost and royalty data
--   for any unit are always self-contained in this row.
--
-- Compliance contract:
--   - serial_number and sku are immutable after creation (trigger below).
--   - Hard delete is prohibited. Deactivate with status = 'voided'.
--   - fraud_locked_at, fraud_locked_by, and fraud_lock_reason must all be
--     populated together. A partial fraud lock is a data integrity violation.
--   - order_id and consultant_id carry no FK to their tables here; those
--     constraints are added in later migrations to avoid forward references.

create table public.serialized_units (
  -- Identity
  id                    uuid                  not null  default gen_random_uuid(),
  -- Physical identifier printed on or embedded in the item.
  -- Globally unique across all units past and present.
  serial_number         text                  not null,
  -- Denormalized from products.sku at receive time. Immutable.
  sku                   text                  not null,
  -- Source product. No ON DELETE because products are never hard-deleted.
  product_id            uuid                  not null  references public.products (id),
  -- Denormalized product name snapshot at receive time.
  product_name          text                  not null,

  -- Lifecycle
  status                public.unit_status    not null  default 'available',

  -- Hologram
  -- Stores a HologramRecord snapshot as JSONB.
  -- Null until a hologram is applied to the unit.
  -- Schema of the embedded object is defined in @gtg/types HologramRecord.
  hologram              jsonb,

  -- Licensing (stamped at receive time, immutable thereafter)
  license_body          public.license_body   not null,
  -- Decimal royalty rate stamped at receive time (e.g. 0.145 = 14.5%).
  -- Copied from product.royalty_rate or active license_holder.default_royalty_rate.
  -- This rate governs the royalty entry when the unit is sold.
  royalty_rate          numeric(5, 4)         not null,

  -- Pricing (stamped at receive time)
  -- Wholesale cost in cents (USD). Denormalized from products.cost_cents.
  cost_cents            integer               not null,
  -- Retail price in cents (USD). Null until unit is assigned to an order.
  -- Captured from order line at sale time; used for royalty and commission math.
  retail_price_cents    integer,

  -- Order linkage (populated when sold)
  -- No FK here — orders table is created in a later migration.
  order_id              uuid,
  -- Consultant who facilitated the sale. Null for direct/admin sales.
  -- No FK here — consultant_profiles table is created in a later migration.
  consultant_id         uuid,

  -- Timestamps
  -- Moment the unit was physically received into inventory.
  received_at           timestamptz           not null  default now(),
  sold_at               timestamptz,
  returned_at           timestamptz,

  -- Fraud lock fields
  -- All three must be null together or non-null together (constraint below).
  fraud_locked_at       timestamptz,
  -- The auth.users.id of the admin who issued the lock.
  fraud_locked_by       uuid                  references auth.users (id),
  fraud_lock_reason     text,

  -- Audit
  updated_at            timestamptz           not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint serialized_units_pkey
    primary key (id),

  -- Serial number is the globally unique physical identifier.
  -- A deactivated (voided) unit's serial_number may not be reused.
  constraint serialized_units_serial_number_unique
    unique (serial_number),

  -- Royalty rate must be a valid fraction.
  constraint serialized_units_royalty_rate_valid
    check (royalty_rate > 0 and royalty_rate <= 1),

  constraint serialized_units_cost_positive
    check (cost_cents > 0),

  -- When set, retail price must be positive.
  constraint serialized_units_retail_price_positive
    check (retail_price_cents is null or retail_price_cents > 0),

  -- Fraud lock fields are an atomic set: all present or all absent.
  -- A unit is either cleanly locked (all three fields populated) or not locked
  -- at all. Mixed state indicates a bug in the lock-issuance code path.
  constraint serialized_units_fraud_lock_consistent
    check (
      (fraud_locked_at is null and fraud_locked_by is null and fraud_lock_reason is null)
      or
      (fraud_locked_at is not null and fraud_locked_by is not null and fraud_lock_reason is not null)
    )
);

-- ─── Immutability Trigger ─────────────────────────────────────────────────────
-- Prevents changes to serial_number and sku after creation.
-- Serial number is the physical identity of the unit.
-- SKU is the stable business key denormalized onto ledger entries and order lines.
-- Both are written to external records at creation time and cannot be changed.

create or replace function public.prevent_unit_key_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.serial_number is distinct from new.serial_number then
    raise exception
      '[GTG] Unit serial_number is immutable. Cannot change serial_number=''%'' to ''%''. '
      'The serial number is the physical identity of the unit and is denormalized '
      'onto ledger entries. Create a new unit instead.',
      old.serial_number, new.serial_number;
  end if;

  if old.sku is distinct from new.sku then
    raise exception
      '[GTG] Unit sku is immutable after creation. Cannot change sku=''%'' to ''%''. '
      'The SKU is stamped onto ledger entries at receive time and cannot be changed.',
      old.sku, new.sku;
  end if;

  return new;
end;
$$;

create trigger serialized_units_immutable_keys
  before update on public.serialized_units
  for each row
  execute function public.prevent_unit_key_update();

-- ─── updated_at Trigger ───────────────────────────────────────────────────────
-- Reuses the shared set_updated_at() function defined in 20260305000001.

create trigger serialized_units_set_updated_at
  before update on public.serialized_units
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- The unique constraint on serial_number already creates a B-tree index.

-- Status is the most common filter: finding available units for sale,
-- fraud_locked units for review, etc.
create index serialized_units_status_idx
  on public.serialized_units (status);

-- Product → units lookup: list all units for a product (admin inventory view).
create index serialized_units_product_id_idx
  on public.serialized_units (product_id);

-- Consultant → units: list units facilitated by a specific consultant.
-- Partial: consultant_id is null for direct/admin sales.
create index serialized_units_consultant_id_idx
  on public.serialized_units (consultant_id)
  where consultant_id is not null;

-- Order → units: look up which units belong to an order.
-- Partial: order_id is null for unsold units.
create index serialized_units_order_id_idx
  on public.serialized_units (order_id)
  where order_id is not null;

-- Royalty reporting: filter by license_body for CLC or Army reports.
-- Excludes voided units, which are never included in royalty calculations.
create index serialized_units_license_body_active_idx
  on public.serialized_units (license_body)
  where status != 'voided';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.serialized_units enable row level security;

-- SELECT: admins may read all units.
create policy "serialized_units_select_admin"
  on public.serialized_units
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: consultants may read units linked to their profile.
-- Allows consultants to view their inventory without exposing other units.
create policy "serialized_units_select_consultant_own"
  on public.serialized_units
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and consultant_id = auth.uid()
  );

-- SELECT: any authenticated user may see units with status = 'available'.
-- Supports storefront availability checks (e.g. "is this product in stock?").
-- Does not expose sold, returned, fraud_locked, or voided unit details.
create policy "serialized_units_select_available"
  on public.serialized_units
  for select
  to authenticated
  using (status = 'available');

-- INSERT: admin only. Units are received by admin users.
create policy "serialized_units_insert_admin"
  on public.serialized_units
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status transitions, fraud locks, and sale assignments
-- are performed by admin-privileged service functions.
create policy "serialized_units_update_admin"
  on public.serialized_units
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: no policy defined. Hard deletes are permanently prohibited.
-- Units may only be voided (status = 'voided').

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.serialized_units is
  'Physical serialized inventory units. Each row is a unique, traceable item '
  'instance created from a product in the catalog. Licensing and cost data are '
  'stamped at receive time and never retroactively changed.';

comment on column public.serialized_units.serial_number is
  'Globally unique physical identifier printed on or embedded in the item. '
  'Immutable after creation. Denormalized onto inventory_ledger_entries '
  'and order_lines at write time.';

comment on column public.serialized_units.sku is
  'Product SKU denormalized from products.sku at receive time. Immutable. '
  'Carried on ledger entries and order lines for historical accuracy.';

comment on column public.serialized_units.hologram is
  'HologramRecord snapshot stored as JSONB. Null until a hologram is '
  'applied. Shape is defined by @gtg/types HologramRecord.';

comment on column public.serialized_units.royalty_rate is
  'Decimal royalty rate (0 < rate ≤ 1) stamped at receive time. Sourced '
  'from product.royalty_rate or the active license_holder.default_royalty_rate '
  'for this unit''s license_body. Never retroactively changed.';

comment on column public.serialized_units.retail_price_cents is
  'Retail price in cents (USD) captured at sale time from the order line. '
  'Null until the unit is sold. This price, not the product catalog price, '
  'governs royalty and commission calculations.';

comment on column public.serialized_units.order_id is
  'UUID of the order that includes this unit. Null until sold. '
  'No FK defined here — constraint added in the orders migration.';

comment on column public.serialized_units.consultant_id is
  'UUID of the consultant_profiles row for the consultant who facilitated '
  'this sale. Null for storefront direct or admin sales. '
  'No FK defined here — constraint added in the consultant_profiles migration.';

comment on column public.serialized_units.fraud_lock_reason is
  'Human-readable description of why the unit was locked. Required whenever '
  'fraud_locked_at is set; the three fraud lock fields are an atomic set.';
