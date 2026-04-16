-- =============================================================================
-- Migration: 20260305000021_commission_tier_config
--
-- Creates:
--   table public.commission_tier_config    rate config for named commission tiers
--   RLS   commission_tier_config           admin write; all authenticated read
--
-- Purpose:
--   The commission_tier enum (migration 5) defines the named tier values but
--   deliberately does not embed rate values — rates change over time and must
--   not require a schema migration to update. This table holds the active rate
--   for each named tier (standard, senior, elite).
--
--   The 'custom' tier is intentionally excluded: its rate lives on
--   consultant_profiles.custom_commission_rate (admin-assigned per consultant).
--
-- Rate change workflow:
--   To change a tier rate, deactivate the current row (is_active = false) and
--   insert a new row with the new rate and a note documenting the change.
--   The partial unique index below prevents two active rows for the same tier.
--   Historical rates are preserved for audit purposes; never update rate in place.
--
-- Seeded rates (defaults — admin should review before production launch):
--   standard  10.00%
--   senior    15.00%
--   elite     20.00%
-- =============================================================================

create table public.commission_tier_config (
  id          uuid                      not null  default gen_random_uuid(),

  -- The tier this rate applies to. 'custom' is excluded (see above).
  tier        public.commission_tier    not null,

  -- Commission rate as a decimal fraction (e.g. 0.15 = 15%).
  -- Applied to the unit's retail_price_cents to produce commission_cents.
  rate        numeric(5, 4)             not null,

  -- Whether this row is the active rate for the tier.
  -- At most one active row per tier (enforced by partial unique index below).
  -- Set to false when superseded by a new rate row; never deleted.
  is_active   boolean                   not null  default true,

  -- Free-text explanation of why this rate was set or changed.
  -- Required when deactivating (is_active → false) and when inserting a new row.
  notes       text,

  -- Admin who inserted this rate row. Null for the seed rows.
  created_by  uuid                                references auth.users (id),

  created_at  timestamptz               not null  default now(),
  updated_at  timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint commission_tier_config_pkey
    primary key (id),

  -- Rate must be a valid positive fraction. Zero commission is not supported
  -- via this table — a consultant with zero commission should be 'custom' tier
  -- with custom_commission_rate = 0.001 or simply not assigned orders.
  constraint commission_tier_config_rate_valid
    check (rate > 0 and rate <= 1),

  -- 'custom' tier rate lives on consultant_profiles, not here.
  -- Inserting a 'custom' row here would create ambiguity.
  constraint commission_tier_config_not_custom
    check (tier != 'custom')
);

-- ─── updated_at trigger ───────────────────────────────────────────────────────
create trigger commission_tier_config_set_updated_at
  before update on public.commission_tier_config
  for each row
  execute function public.set_updated_at();

-- ─── Partial unique index ─────────────────────────────────────────────────────
-- Ensures at most one active rate row per tier at any point in time.
-- Deactivated (is_active = false) rows are excluded so historical rates
-- accumulate without violating uniqueness.
create unique index commission_tier_config_active_tier_unique
  on public.commission_tier_config (tier)
  where is_active = true;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.commission_tier_config enable row level security;

-- SELECT: any authenticated user may read active tier rates.
-- Consultants and storefront need to display their commission rate.
create policy "commission_tier_config_select_authenticated"
  on public.commission_tier_config
  for select
  to authenticated
  using (true);

-- INSERT: admin only. Rate changes require admin authority.
create policy "commission_tier_config_insert_admin"
  on public.commission_tier_config
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Used only to set is_active = false when superseding.
-- The rate column itself should never be updated in place — deactivate + insert.
create policy "commission_tier_config_update_admin"
  on public.commission_tier_config
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Deactivate (is_active = false) to supersede a rate.

-- ─── Seed: default rates ──────────────────────────────────────────────────────
-- Review before production launch. These are starting points, not business
-- requirements. Change via deactivate-and-insert workflow described above.

insert into public.commission_tier_config (tier, rate, notes, created_by) values
  ('standard', 0.1000, 'Initial default rate: 10.00%. Review before launch.', null),
  ('senior',   0.1500, 'Initial default rate: 15.00%. Review before launch.', null),
  ('elite',    0.2000, 'Initial default rate: 20.00%. Review before launch.', null);

-- ─── Column documentation ─────────────────────────────────────────────────────
comment on table public.commission_tier_config is
  'Active commission rates for named tiers (standard, senior, elite). '
  'The ''custom'' tier is excluded — its rate lives on consultant_profiles. '
  'Never update rate in place; deactivate the current row and insert a new one '
  'to preserve the historical rate record.';

comment on column public.commission_tier_config.rate is
  'Commission rate as a decimal fraction (e.g. 0.15 = 15.00%). '
  'Applied to order_line.retail_price_cents to produce commission_cents. '
  'Must be > 0 and <= 1.';

comment on column public.commission_tier_config.is_active is
  'Whether this row is the currently active rate for the tier. '
  'At most one active row per tier (partial unique index enforces this). '
  'Set to false when superseded — never deleted.';
