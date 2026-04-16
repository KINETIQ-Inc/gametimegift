-- =============================================================================
-- Migration: 20260305000009_create_commission_entries
--
-- Creates:
--   type  public.commission_status       enum for commission lifecycle
--   table public.commission_entries      per-unit commission obligations
--   RLS   commission_entries             admin all; consultant own
--   alter public.order_lines             adds commission_entry_id FK constraint
-- =============================================================================

-- ─── Enum: commission_status ──────────────────────────────────────────────────
-- Lifecycle of a single commission obligation.
--
-- SYNC REQUIREMENT: values must match @gtg/types CommissionStatus exactly.

create type public.commission_status as enum (
  'earned',    -- Sale completed; commission calculated; pending approval
  'held',      -- Withheld pending resolution (suspension, fraud review)
  'approved',  -- Cleared for payout
  'paid',      -- Disbursed to consultant
  'reversed',  -- Clawed back due to return or confirmed fraud
  'voided'     -- Invalidated by system correction
);

-- ─── Table: commission_entries ────────────────────────────────────────────────
-- One row per sold serialized unit, per consultant.
-- There is no aggregation at this level — payout batches are assembled
-- from multiple 'approved' commission_entry rows.
--
-- Denormalization contract:
--   At creation, consultant_name, serial_number, sku, product_name,
--   retail_price_cents, commission_tier, commission_rate, and commission_cents
--   are stamped from the sale context. They do not change if the consultant's
--   tier or product price changes after the fact.
--
-- Immutability contract:
--   Once status reaches 'paid', the entry is immutable.
--   Corrections after payment require a new offsetting entry.
--   hold_reason is only set when status is or was 'held'.
--   reversal_reason is required when status transitions to 'reversed'.
--
-- Compliance contract:
--   Hard delete is prohibited.
--   payout_batch_id references a future payout_batches table (no FK yet).

create table public.commission_entries (
  -- Identity
  id                    uuid                      not null  default gen_random_uuid(),

  -- Consultant linkage
  consultant_id         uuid                      not null  references public.consultant_profiles (id),
  -- Denormalized legal name at time of sale (first + last, formatted).
  consultant_name       text                      not null,

  -- Unit and order linkage
  unit_id               uuid                      not null  references public.serialized_units (id),
  order_id              uuid                      not null  references public.orders (id),

  -- Denormalized unit/sale fields (stamped at creation)
  serial_number         text                      not null,
  sku                   text                      not null,
  product_name          text                      not null,
  -- Retail price in cents at time of sale. Basis for commission calculation.
  retail_price_cents    integer                   not null,

  -- Commission calculation (stamped at creation)
  commission_tier       public.commission_tier    not null,
  commission_rate       numeric(5, 4)             not null,
  -- commission_cents = retail_price_cents × commission_rate (rounded to nearest cent).
  commission_cents      integer                   not null,

  -- Lifecycle
  status                public.commission_status  not null  default 'earned',
  hold_reason           text,
  reversal_reason       text,

  -- Payout linkage
  -- References payout_batches.id. No FK — payout_batches is a future table.
  payout_batch_id       uuid,

  -- Status transition timestamps
  approved_at           timestamptz,
  approved_by           uuid                      references auth.users (id),
  paid_at               timestamptz,
  reversed_at           timestamptz,

  -- Audit
  created_at            timestamptz               not null  default now(),
  updated_at            timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint commission_entries_pkey
    primary key (id),

  -- One commission entry per unit. A unit sold once produces one entry.
  -- A reversed and re-sold unit would produce a second entry for the new sale.
  constraint commission_entries_unit_unique
    unique (unit_id),

  constraint commission_entries_retail_price_positive
    check (retail_price_cents > 0),

  constraint commission_entries_commission_rate_valid
    check (commission_rate > 0 and commission_rate <= 1),

  constraint commission_entries_commission_cents_nonneg
    check (commission_cents >= 0),

  -- hold_reason is only meaningful when the entry is or was held.
  -- reversal_reason is required when reversed.
  constraint commission_entries_reversal_reason_required
    check (
      status != 'reversed'
      or reversal_reason is not null
    ),

  -- approved_at and approved_by must be set together.
  constraint commission_entries_approval_consistent
    check (
      (approved_at is null and approved_by is null)
      or
      (approved_at is not null and approved_by is not null)
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger commission_entries_set_updated_at
  before update on public.commission_entries
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on unit_id creates an index.

-- Consultant → commissions: primary query for consultant payout dashboard.
create index commission_entries_consultant_id_idx
  on public.commission_entries (consultant_id);

-- Status filter: find all 'approved' entries for a payout run.
create index commission_entries_status_idx
  on public.commission_entries (status);

-- Consultant + status: approved commissions for a specific consultant.
create index commission_entries_consultant_status_idx
  on public.commission_entries (consultant_id, status);

-- Payout batch → entries: list all commissions included in a batch.
create index commission_entries_payout_batch_id_idx
  on public.commission_entries (payout_batch_id)
  where payout_batch_id is not null;

-- Order → commissions.
create index commission_entries_order_id_idx
  on public.commission_entries (order_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.commission_entries enable row level security;

-- SELECT: admin reads all entries.
create policy "commission_entries_select_admin"
  on public.commission_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- SELECT: consultants see their own commission entries.
create policy "commission_entries_select_consultant_own"
  on public.commission_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and consultant_id in (
      select id from public.consultant_profiles
      where auth_user_id = auth.uid()
    )
  );

-- INSERT: admin only. Entries are created by order fulfillment functions.
create policy "commission_entries_insert_admin"
  on public.commission_entries
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Status transitions, holds, approvals, reversals.
create policy "commission_entries_update_admin"
  on public.commission_entries
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited.

-- ─── Deferred FK: order_lines.commission_entry_id ────────────────────────────
-- commission_entries now exists; add the FK constraint to order_lines.

alter table public.order_lines
  add constraint order_lines_commission_entry_id_fkey
    foreign key (commission_entry_id) references public.commission_entries (id);

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.commission_entries is
  'One row per sold serialized unit, per consultant. Each entry records the '
  'commission obligation from initial ''earned'' status through to ''paid'' or '
  '''reversed''. Payout batches aggregate multiple approved entries.';

comment on column public.commission_entries.commission_cents is
  'Commission amount: retail_price_cents × commission_rate, rounded to the '
  'nearest cent. Stamped at sale time. Immutable after the entry reaches ''paid''.';

comment on column public.commission_entries.payout_batch_id is
  'UUID of the payout batch that included this entry. No FK constraint — '
  'payout_batches is a future table. Null until status reaches ''paid''.';

comment on column public.commission_entries.reversal_reason is
  'Required when status transitions to ''reversed''. Documents whether the '
  'reversal was due to a customer return, fraud confirmation, or system correction.';
