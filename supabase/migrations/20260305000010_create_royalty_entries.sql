-- =============================================================================
-- Migration: 20260305000010_create_royalty_entries
--
-- Creates:
--   type  public.royalty_status          enum for royalty obligation lifecycle
--   table public.royalty_entries         period royalty obligations per licensor
--   RLS   royalty_entries                admin write; admin + auditor read
-- =============================================================================

-- ─── Enum: royalty_status ─────────────────────────────────────────────────────
-- Lifecycle of a royalty obligation, from initial calculation through payment.
--
-- SYNC REQUIREMENT: values must match @gtg/types RoyaltyStatus exactly.

create type public.royalty_status as enum (
  'calculated',    -- Computed from ledger; not yet submitted to licensor
  'submitted',     -- Report filed with CLC or Army
  'acknowledged',  -- Licensor confirmed receipt
  'disputed',      -- Licensor raised a discrepancy
  'resolved',      -- Dispute closed; corrected amount agreed upon
  'paid',          -- Payment cleared
  'voided'         -- Entry invalidated (duplicate, system error)
);

-- ─── Table: royalty_entries ───────────────────────────────────────────────────
-- One row covers one license_body for one reporting period.
-- It is the unit of submission to CLC and U.S. Army.
--
-- Audit chain:
--   ledger_entry_ids is an array of inventory_ledger_entries.id rows with
--   action = 'sold' that were included in this calculation. It provides a
--   complete, traversable audit trail from the royalty payment back to
--   individual unit sales — every dollar is accounted for.
--
-- Minimum floor:
--   If the period's calculated royalty (royalty_cents) falls below the
--   license_holder's minimum_royalty_cents, remittance_cents is set to
--   the minimum and minimum_applied = true. The delta is tracked for
--   reconciliation and dispute resolution.
--
-- Immutability contract:
--   'calculated' entries may be amended before submission.
--   Once status reaches 'submitted', corrections require a new entry
--   with an offsetting adjustment (adjusted_remittance_cents).
--   Hard delete is prohibited.

create table public.royalty_entries (
  -- Identity
  id                          uuid                      not null  default gen_random_uuid(),

  -- License holder linkage
  license_holder_id           uuid                      not null  references public.license_holders (id),
  -- Denormalized at calculation time — preserved if the holder record changes.
  license_body                public.license_body       not null,
  license_holder_name         text                      not null,

  -- Reporting period
  reporting_period            public.reporting_period   not null,
  -- ISO 8601 date — first day of the period (inclusive).
  period_start                date                      not null,
  -- ISO 8601 date — last day of the period (inclusive).
  period_end                  date                      not null,

  -- Audit chain
  -- Array of inventory_ledger_entries.id rows (action = 'sold') included
  -- in this calculation. Must be complete before status advances past 'calculated'.
  ledger_entry_ids            uuid[]                    not null  default '{}',

  -- Aggregates
  units_sold                  integer                   not null,
  gross_sales_cents           integer                   not null,

  -- Royalty calculation
  royalty_rate                numeric(5, 4)             not null,
  -- gross_sales_cents × royalty_rate, rounded to nearest cent.
  royalty_cents               integer                   not null,
  -- Amount actually remitted: equals royalty_cents unless minimum applied.
  remittance_cents            integer                   not null,
  -- True when minimum_royalty_cents floor was applied.
  minimum_applied             boolean                   not null  default false,

  -- Lifecycle
  status                      public.royalty_status     not null  default 'calculated',

  -- Submission fields (null until submitted)
  -- Reference ID assigned by the licensor on submission acknowledgement.
  licensor_reference_id       text,
  submitted_at                timestamptz,
  submitted_by                uuid                      references auth.users (id),

  -- Payment fields (null until paid)
  paid_at                     timestamptz,
  payment_reference           text,

  -- Dispute resolution fields (null unless disputed or resolved)
  dispute_note                text,
  resolution_note             text,
  -- Adjusted amount agreed upon after dispute resolution.
  -- Null if no dispute or if resolved with original remittance amount.
  adjusted_remittance_cents   integer,

  -- Audit
  created_at                  timestamptz               not null  default now(),
  created_by                  uuid                      not null  references auth.users (id),
  updated_at                  timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint royalty_entries_pkey
    primary key (id),

  -- One entry per license body per reporting period (no duplicates).
  -- A voided entry does not free the slot — voiding requires admin review,
  -- not automatic re-calculation. This uniqueness is advisory in that
  -- voided entries are included in the unique check.
  constraint royalty_entries_period_unique
    unique (license_holder_id, period_start, period_end),

  constraint royalty_entries_period_ordered
    check (period_end >= period_start),

  constraint royalty_entries_royalty_rate_valid
    check (royalty_rate > 0 and royalty_rate <= 1),

  constraint royalty_entries_units_sold_positive
    check (units_sold > 0),

  constraint royalty_entries_gross_sales_nonneg
    check (gross_sales_cents >= 0),

  constraint royalty_entries_royalty_cents_nonneg
    check (royalty_cents >= 0),

  constraint royalty_entries_remittance_nonneg
    check (remittance_cents >= 0),

  -- Remittance must be >= calculated royalty (minimum floor can only increase it).
  constraint royalty_entries_remittance_gte_royalty
    check (remittance_cents >= royalty_cents),

  constraint royalty_entries_adjusted_remittance_nonneg
    check (adjusted_remittance_cents is null or adjusted_remittance_cents >= 0),

  -- Submission consistency: submitted_at and submitted_by together.
  constraint royalty_entries_submission_consistent
    check (
      (submitted_at is null and submitted_by is null)
      or
      (submitted_at is not null and submitted_by is not null)
    ),

  -- Payment consistency: paid_at requires payment_reference.
  constraint royalty_entries_payment_consistent
    check (
      paid_at is null
      or (paid_at is not null and payment_reference is not null)
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger royalty_entries_set_updated_at
  before update on public.royalty_entries
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on (license_holder_id, period_start, period_end) creates an index.

-- Status filter: find all entries due for submission or payment.
create index royalty_entries_status_idx
  on public.royalty_entries (status);

-- License body + period: primary query for generating period reports.
create index royalty_entries_license_body_period_idx
  on public.royalty_entries (license_body, period_start desc);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.royalty_entries enable row level security;

-- SELECT: admins and licensor auditors may read royalty entries.
-- Auditors use this for reconciliation during licensor reviews.
create policy "royalty_entries_select_privileged"
  on public.royalty_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Entries are created by the royalty calculation job.
create policy "royalty_entries_insert_admin"
  on public.royalty_entries
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status transitions, submission, dispute resolution.
create policy "royalty_entries_update_admin"
  on public.royalty_entries
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Void with status = 'voided'.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.royalty_entries is
  'Period royalty obligations — one row per license body per reporting period. '
  'The unit of submission to CLC and U.S. Army. ledger_entry_ids provides '
  'the complete audit chain from royalty payment back to individual unit sales.';

comment on column public.royalty_entries.ledger_entry_ids is
  'UUIDs of inventory_ledger_entries rows (action = ''sold'') that contributed '
  'to this calculation. Must be exhaustive — every covered sale must be listed. '
  'Array order is not significant.';

comment on column public.royalty_entries.remittance_cents is
  'Actual amount remitted to the licensor. Equals royalty_cents unless the '
  'minimum floor was applied, in which case it equals '
  'license_holder.minimum_royalty_cents.';

comment on column public.royalty_entries.adjusted_remittance_cents is
  'Amount agreed upon after dispute resolution. Null if no dispute occurred '
  'or if the dispute was resolved with the original remittance amount.';

comment on column public.royalty_entries.licensor_reference_id is
  'Reference number assigned by the licensor upon acknowledgement of the report. '
  'Required for payment matching and future audit correspondence.';
