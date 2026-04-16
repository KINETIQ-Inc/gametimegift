-- =============================================================================
-- Migration: 20260305000005_create_consultant_profiles
--
-- Creates:
--   type  public.consultant_status       enum for consultant account lifecycle
--   type  public.commission_tier         enum for commission rate tier
--   table public.consultant_profiles     consultant account records
--   RLS   consultant_profiles            admin all; consultant own profile
--   alter public.serialized_units        adds consultant_id FK constraint
-- =============================================================================

-- ─── Enum: consultant_status ──────────────────────────────────────────────────
-- Lifecycle states for a consultant account.
-- Determines whether the consultant may make sales and earn commissions.
--
-- SYNC REQUIREMENT: values must match @gtg/types ConsultantStatus exactly.

create type public.consultant_status as enum (
  'pending_approval',  -- Application submitted; awaiting admin review
  'active',            -- Approved and earning commissions
  'suspended',         -- Temporarily blocked; commissions held
  'terminated'         -- Permanently removed; no further accrual
);

-- ─── Enum: commission_tier ────────────────────────────────────────────────────
-- Commission rate tier assigned to a consultant.
-- Rate values for each tier live in the admin config, not on this enum.
-- The tier is denormalized onto CommissionEntry and OrderLine at sale time.
--
-- SYNC REQUIREMENT: values must match @gtg/types CommissionTier exactly.

create type public.commission_tier as enum (
  'standard',  -- Default tier for new consultants
  'senior',    -- Elevated rate; requires lifetime sales threshold
  'elite',     -- Highest standard tier
  'custom'     -- Admin-assigned rate; requires custom_commission_rate != null
);

-- ─── Table: consultant_profiles ───────────────────────────────────────────────
-- A registered Game Time Gift sales consultant.
-- 1:1 with an auth.users row via auth_user_id.
--
-- Tax compliance contract:
--   - No commission payout may occur while tax_onboarding_complete = false.
--   - tax_id is stored encrypted at rest (application responsibility).
--     Never log or transmit tax_id in plaintext.
--
-- Running totals (lifetime_gross_sales_cents, lifetime_commissions_cents,
-- pending_payout_cents) are updated transactionally when commissions are
-- created, approved, or paid. They are NOT recomputed from the ledger on
-- every read — treat them as the authoritative running figures.
--
-- Compliance contract:
--   - Hard delete is prohibited. Terminate with status = 'terminated'.
--   - custom_commission_rate is only valid when commission_tier = 'custom'.

create table public.consultant_profiles (
  -- Identity
  id                          uuid                      not null  default gen_random_uuid(),
  -- Foreign key → auth.users.id. 1:1 with the consultant's login identity.
  auth_user_id                uuid                      not null  references auth.users (id),

  -- Status
  status                      public.consultant_status  not null  default 'pending_approval',

  -- Legal identity (immutable after onboarding)
  legal_first_name            text                      not null,
  legal_last_name             text                      not null,

  -- Mutable contact / display fields
  display_name                text                      not null,
  email                       text                      not null,
  phone                       text,

  -- Tax onboarding
  -- Encrypted at rest. Never log or transmit in plaintext.
  tax_id                      text,
  tax_onboarding_complete     boolean                   not null  default false,
  -- ConsultantAddress stored as JSONB. Null until tax onboarding complete.
  address                     jsonb,

  -- Commission
  commission_tier             public.commission_tier    not null  default 'standard',
  -- Only populated when commission_tier = 'custom'.
  custom_commission_rate      numeric(5, 4),

  -- Running totals
  lifetime_gross_sales_cents  integer                   not null  default 0,
  lifetime_commissions_cents  integer                   not null  default 0,
  pending_payout_cents        integer                   not null  default 0,

  -- Referral
  -- UUID of the referring consultant_profiles.id. Null for top-level consultants.
  referred_by                 uuid,

  -- Lifecycle timestamps
  activated_at                timestamptz,
  last_sale_at                timestamptz,

  -- Status change audit (populated on every status change)
  status_changed_at           timestamptz,
  status_changed_by           uuid                      references auth.users (id),
  status_change_reason        text,

  -- Audit
  created_at                  timestamptz               not null  default now(),
  updated_at                  timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint consultant_profiles_pkey
    primary key (id),

  -- One consultant per auth user.
  constraint consultant_profiles_auth_user_unique
    unique (auth_user_id),

  constraint consultant_profiles_email_format
    check (email like '%@%'),

  -- custom_commission_rate is only valid for the 'custom' tier.
  constraint consultant_profiles_custom_rate_tier_consistent
    check (
      commission_tier = 'custom' or custom_commission_rate is null
    ),

  constraint consultant_profiles_custom_rate_valid
    check (
      custom_commission_rate is null
      or (custom_commission_rate > 0 and custom_commission_rate <= 1)
    ),

  -- Running totals must be non-negative.
  constraint consultant_profiles_gross_sales_nonneg
    check (lifetime_gross_sales_cents >= 0),

  constraint consultant_profiles_commissions_nonneg
    check (lifetime_commissions_cents >= 0),

  constraint consultant_profiles_pending_payout_nonneg
    check (pending_payout_cents >= 0),

  -- Status change fields are populated together.
  -- If status_changed_at is set, the admin responsible must also be recorded.
  constraint consultant_profiles_status_change_consistent
    check (
      status_changed_at is null
      or (status_changed_at is not null and status_changed_by is not null)
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger consultant_profiles_set_updated_at
  before update on public.consultant_profiles
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on auth_user_id already creates an index.

-- Status filter: find all active or suspended consultants.
create index consultant_profiles_status_idx
  on public.consultant_profiles (status);

-- Commission tier: tier-based reporting and rate lookups.
create index consultant_profiles_tier_idx
  on public.consultant_profiles (commission_tier)
  where status = 'active';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.consultant_profiles enable row level security;

-- SELECT: admin reads all profiles (including inactive and terminated).
create policy "consultant_profiles_select_admin"
  on public.consultant_profiles
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: a consultant reads only their own profile.
-- Identified by auth_user_id = auth.uid(), not by the profile id.
create policy "consultant_profiles_select_own"
  on public.consultant_profiles
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and auth_user_id = auth.uid()
  );

-- INSERT: admin only. Consultant accounts are created by admin users.
create policy "consultant_profiles_insert_admin"
  on public.consultant_profiles
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status changes, tier promotions, tax updates.
create policy "consultant_profiles_update_admin"
  on public.consultant_profiles
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Terminate with status = 'terminated'.

-- ─── Deferred FK: serialized_units.consultant_id ─────────────────────────────
-- This FK was deferred at serialized_units creation to avoid a forward reference.
-- consultant_profiles now exists; the constraint is safe to add.

alter table public.serialized_units
  add constraint serialized_units_consultant_id_fkey
    foreign key (consultant_id) references public.consultant_profiles (id);

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.consultant_profiles is
  'Registered Game Time Gift sales consultants. 1:1 with auth.users via auth_user_id. '
  'Tracks commission tier, tax onboarding state, and running payout totals. '
  'Hard delete is prohibited — terminate with status = ''terminated''.';

comment on column public.consultant_profiles.tax_id is
  'Tax identification number (SSN or EIN) for 1099 reporting. '
  'Stored encrypted at rest by the application layer. '
  'Must never appear in logs, API responses, or error messages.';

comment on column public.consultant_profiles.custom_commission_rate is
  'Rate override as a decimal fraction. Only valid when commission_tier = ''custom''. '
  'Null for all other tiers — rate is resolved from the tier configuration.';

comment on column public.consultant_profiles.pending_payout_cents is
  'Commissions in ''approved'' status awaiting the next payout run. '
  'Decremented when a payout batch includes this consultant.';

comment on column public.consultant_profiles.referred_by is
  'UUID of the referring consultant_profiles row. Null for top-level consultants. '
  'No FK defined to avoid a self-referential cascade complexity.';
