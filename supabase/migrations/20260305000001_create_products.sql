-- =============================================================================
-- Migration: 20260305000001_create_products
--
-- Creates:
--   type  public.license_body            shared enum (earliest migration that needs it)
--   func  public.set_updated_at()        shared trigger helper (reused by all tables)
--   func  public.prevent_sku_update()    immutability guard
--   table public.products                product catalog
--   RLS   products                       admin write, authenticated read (active only)
-- =============================================================================

-- ─── Enum: license_body ──────────────────────────────────────────────────────
-- Identifies the royalty-bearing licensing authority for a product or unit.
-- Shared across: products, serialized_units, inventory_ledger_entries,
--                order_lines, royalty_entries.
-- Created here — the earliest migration that requires it.
--
-- SYNC REQUIREMENT: values must match @gtg/types LicenseBody exactly.
-- Adding a value requires both a SQL ALTER TYPE and a TypeScript union update.

create type public.license_body as enum (
  'CLC',   -- Collegiate Licensing Company
  'ARMY',  -- U.S. Army licensing authority
  'NONE'   -- No royalty obligation (e.g. non-licensed accessories)
);

-- ─── Shared Trigger Function: set_updated_at ─────────────────────────────────
-- Sets updated_at = now() before every UPDATE.
-- Created once here and reused by every table that has an updated_at column.
-- Do NOT redefine this function in subsequent migrations.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ─── Table: products ─────────────────────────────────────────────────────────
-- Product catalog. Each row defines a licensable item type.
-- Serialized units are physical instances of a product; they are created from
-- this catalog and inherit sku, license_body, and royalty_rate at creation time.
--
-- Compliance contract:
--   - SKU is immutable after creation (enforced by trigger below).
--     It is the stable business key denormalized onto units, ledger entries,
--     commission entries, and order lines. A SKU change would orphan all
--     historical records that carried it.
--   - royalty_rate, when set, overrides the active license_holder.default_royalty_rate
--     for this product's license_body. When null, the holder default is used.
--   - Hard delete is prohibited. Deactivate with is_active = false.

create table public.products (
  -- Identity
  id                    uuid                  not null  default gen_random_uuid(),
  -- Immutable business key. Format: UPPERCASE, alphanumeric, hyphens.
  -- Example: APP-NIKE-JERSEY-M, ACC-ARMY-KEYCHAIN
  sku                   text                  not null,
  name                  text                  not null,
  description           text,

  -- Licensing
  license_body          public.license_body   not null  default 'NONE',
  -- Per-product royalty rate as a decimal fraction (e.g. 0.145 = 14.5%).
  -- null → inherit active license_holder.default_royalty_rate at unit creation.
  -- Stamped onto the unit at receive time and never retroactively changed.
  royalty_rate          numeric(5, 4),

  -- Pricing
  -- Wholesale cost in cents (USD). Used for margin and profitability reporting.
  cost_cents            integer               not null,
  -- Default retail price in cents (USD).
  -- Order lines may capture a different price at sale time; this is the default.
  retail_price_cents    integer               not null,

  -- Lifecycle
  is_active             boolean               not null  default true,

  -- Audit
  created_at            timestamptz           not null  default now(),
  updated_at            timestamptz           not null  default now(),
  -- The admin user who added this product. References Supabase Auth.
  created_by            uuid                  not null  references auth.users (id),

  -- ── Constraints ────────────────────────────────────────────────────────────
  constraint products_pkey
    primary key (id),

  -- SKU must be globally unique across all products, active or inactive.
  -- A deactivated product's SKU may not be reused; historical records carry it.
  constraint products_sku_unique
    unique (sku),

  -- SKU format: uppercase letters, digits, and hyphens only.
  -- Must start with a letter or digit. Length 3–50 characters.
  -- Enforced in addition to application-level validation.
  constraint products_sku_format
    check (sku ~ '^[A-Z0-9][A-Z0-9-]{2,49}$'),

  -- Royalty rate must be a valid fraction when provided.
  constraint products_royalty_rate_valid
    check (
      royalty_rate is null
      or (royalty_rate > 0 and royalty_rate <= 1)
    ),

  -- Cost must be a positive amount. Zero-cost products are not permitted;
  -- comp/sample items use a nominal cost in the catalog.
  constraint products_cost_positive
    check (cost_cents > 0),

  constraint products_retail_price_positive
    check (retail_price_cents > 0),

  -- Retail price must be at least equal to cost.
  -- Prevents catalog misconfiguration that would produce negative gross margin.
  constraint products_retail_gte_cost
    check (retail_price_cents >= cost_cents)
);

-- ─── SKU Immutability Trigger ─────────────────────────────────────────────────
-- SKU changes are rejected at the database level regardless of who issues the UPDATE.
-- The error message names the old and new values to aid debugging.

create or replace function public.prevent_sku_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.sku is distinct from new.sku then
    raise exception
      '[GTG] Product SKU is immutable. Cannot change sku=''%'' to ''%''. '
      'SKU is the stable key across units, ledger entries, and commission records. '
      'Create a new product instead.',
      old.sku, new.sku;
  end if;
  return new;
end;
$$;

create trigger products_immutable_sku
  before update on public.products
  for each row
  execute function public.prevent_sku_update();

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger products_set_updated_at
  before update on public.products
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- The unique constraint on sku already creates a B-tree index; no duplicate needed.

-- Filter by license_body when scoping royalty reports to CLC or Army products.
-- Partial index on active products only — inactive products are excluded from
-- all royalty calculations and are not queried by license_body in production.
create index products_license_body_active_idx
  on public.products (license_body)
  where is_active = true;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.products enable row level security;

-- SELECT: all authenticated users may read active products.
-- This allows consultants and storefront to browse the catalog.
create policy "products_select_active"
  on public.products
  for select
  to authenticated
  using (is_active = true);

-- SELECT: admins may read all products, including inactive.
-- Permissive policies are OR-combined: an admin satisfies this policy even
-- when the row would be excluded by products_select_active.
create policy "products_select_admin"
  on public.products
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- INSERT: admin only.
create policy "products_insert_admin"
  on public.products
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. SKU immutability is enforced by trigger, not by RLS.
create policy "products_update_admin"
  on public.products
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: no policy is defined. Hard deletes are permanently prohibited.
-- Products may only be deactivated (is_active = false).
-- This applies even to admins and super_admins.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.products is
  'Product catalog. Defines licensable item types from which serialized units '
  'are created. Each product carries a license classification and royalty rate '
  'that are stamped onto units at receive time.';

comment on column public.products.sku is
  'Immutable product identifier. Uppercase alphanumeric with hyphens, 3–50 chars. '
  'Denormalized onto serialized_units, inventory_ledger_entries, commission_entries, '
  'and order_lines. Cannot be changed once any unit exists for this product.';

comment on column public.products.license_body is
  'Royalty-bearing authority: CLC, ARMY, or NONE. Determines which '
  'license_holder record supplies the default royalty rate and which '
  'reporting format is used for royalty submissions.';

comment on column public.products.royalty_rate is
  'Per-product royalty rate override as a decimal fraction (0 < rate ≤ 1). '
  'When null, the active license_holder.default_royalty_rate for this '
  'license_body is used when a unit is received. Rate is stamped onto the '
  'unit at creation and is never retroactively changed.';

comment on column public.products.cost_cents is
  'Wholesale cost in cents (USD). Used for gross margin and profitability '
  'reporting. Must be > 0; use a nominal amount for comp/sample items.';

comment on column public.products.retail_price_cents is
  'Default retail price in cents (USD). Captured on order lines at sale time; '
  'the order line price governs royalty and commission calculations, not this field.';
