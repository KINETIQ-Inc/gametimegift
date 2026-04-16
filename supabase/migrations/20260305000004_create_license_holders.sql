-- =============================================================================
-- Migration: 20260305000004_create_license_holders
--
-- Creates:
--   type  public.reporting_period        enum for royalty reporting cadence
--   table public.license_holders         licensing authority rate records
--   RLS   license_holders                admin write; admin + auditor read
-- =============================================================================

-- ─── Enum: reporting_period ───────────────────────────────────────────────────
-- Royalty reporting cadence required by a license agreement.
-- CLC requires quarterly; U.S. Army requires monthly.
-- Stored on license_holders and denormalized onto royalty_entries.
--
-- SYNC REQUIREMENT: values must match @gtg/types ReportingPeriod exactly.

create type public.reporting_period as enum (
  'monthly',
  'quarterly',
  'annual'
);

-- ─── Table: license_holders ───────────────────────────────────────────────────
-- Contractual rate records for each royalty-bearing licensing authority.
--
-- Rate versioning contract:
--   Rates are append-only. When a rate agreement changes, a new row is inserted
--   with the updated rate, rate_effective_date, and the old row's rate_expiry_date
--   is set. Only one row per license_body may have is_active = true at a time
--   (enforced by application logic, not a unique constraint — allows a brief
--   overlap window during rate transitions).
--
-- Compliance contract:
--   - Hard delete is prohibited. Superseded rate records must be retained
--     for audit trail of historical royalty calculations.
--   - default_royalty_rate and minimum_royalty_cents are immutable after creation.
--     A rate change requires a new record, not an UPDATE.
--   - Only contact_name, contact_email, is_active, and rate_expiry_date may be
--     updated on an existing record.

create table public.license_holders (
  -- Identity
  id                    uuid              not null  default gen_random_uuid(),
  -- The royalty authority this record governs.
  license_body          public.license_body  not null,
  -- Legal entity name as it appears on the license agreement.
  legal_name            text              not null,
  -- Short code for report filenames and internal references (e.g. 'CLC', 'ARMY-IPR').
  code                  text              not null,

  -- Contact
  contact_name          text              not null,
  contact_email         text              not null,

  -- Rate agreement (immutable after creation)
  -- Default rate as a decimal fraction (e.g. 0.145 = 14.5%).
  -- Individual products may override via products.royalty_rate.
  default_royalty_rate  numeric(5, 4)     not null,
  -- Minimum royalty due per reporting period in cents (USD).
  -- Null if the agreement has no minimum floor.
  minimum_royalty_cents integer,
  -- Reporting cadence required by this agreement.
  reporting_period      public.reporting_period  not null,

  -- Rate validity window
  -- ISO 8601 date (not timestamptz) — rate agreements are date-scoped.
  rate_effective_date   date              not null,
  -- Null for open-ended agreements. Set when a new rate record supersedes this one.
  rate_expiry_date      date,

  -- Lifecycle
  is_active             boolean           not null  default true,

  -- Audit
  created_at            timestamptz       not null  default now(),
  created_by            uuid              not null  references auth.users (id),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint license_holders_pkey
    primary key (id),

  constraint license_holders_code_unique
    unique (code),

  -- Code format: uppercase letters, digits, hyphens. 2–20 chars.
  constraint license_holders_code_format
    check (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),

  constraint license_holders_rate_valid
    check (default_royalty_rate > 0 and default_royalty_rate <= 1),

  constraint license_holders_minimum_positive
    check (minimum_royalty_cents is null or minimum_royalty_cents > 0),

  -- Rate window must be ordered when expiry is set.
  constraint license_holders_rate_window_valid
    check (rate_expiry_date is null or rate_expiry_date > rate_effective_date),

  constraint license_holders_email_format
    check (contact_email like '%@%')
);

-- ─── No updated_at ────────────────────────────────────────────────────────────
-- license_holders has no updated_at column. The mutable fields (contact_name,
-- contact_email, is_active, rate_expiry_date) are administrative only and their
-- change history is not required at the row level. The full audit trail for
-- rate history is provided by the append-only versioning pattern.

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on code already creates a B-tree index.

-- Look up the active rate record for a given license body.
-- Most common query: "what is the current rate for CLC?"
create index license_holders_body_active_idx
  on public.license_holders (license_body)
  where is_active = true;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.license_holders enable row level security;

-- SELECT: admins and licensor auditors may read all rate records.
-- Auditors need full rate history for compliance reconciliation.
create policy "license_holders_select_privileged"
  on public.license_holders
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. New rate records are created by admin users.
create policy "license_holders_insert_admin"
  on public.license_holders
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Only contact fields, is_active, and rate_expiry_date.
-- Immutable fields (rates, dates) are protected by application logic.
create policy "license_holders_update_admin"
  on public.license_holders
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Rate history is retained for compliance.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.license_holders is
  'Append-only rate agreement records for each royalty-bearing licensing authority. '
  'When rates change, a new row is inserted and the prior row''s rate_expiry_date '
  'is set. Only one row per license_body is active at a time.';

comment on column public.license_holders.default_royalty_rate is
  'Default royalty rate as a decimal fraction (0 < rate ≤ 1) for this agreement. '
  'Applied to units whose product has no royalty_rate override. '
  'Immutable after creation — a rate change requires a new record.';

comment on column public.license_holders.minimum_royalty_cents is
  'Minimum royalty due per reporting period in cents (USD). '
  'If the period''s calculated royalty falls below this, the minimum is remitted. '
  'Null when the agreement has no minimum floor.';

comment on column public.license_holders.rate_expiry_date is
  'Date this rate agreement expires (exclusive). Null for open-ended agreements. '
  'Set when a new rate record supersedes this one.';

comment on column public.license_holders.is_active is
  'Whether this record is the currently effective rate agreement for its license_body. '
  'Exactly one record per license_body should be active at a time. '
  'Set to false when the agreement is superseded.';
