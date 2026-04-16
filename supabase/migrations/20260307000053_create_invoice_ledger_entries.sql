-- =============================================================================
-- Migration: 20260307000053_create_invoice_ledger_entries
--
-- Phase 4B-5: invoice_ledger
-- Objective:
--   - Create immutable invoice ledger entries for invoice lifecycle auditing.
--   - Enforce valid status-transition event semantics.
-- =============================================================================

-- ─── Enum: invoice_ledger_event ──────────────────────────────────────────────

create type public.invoice_ledger_event as enum (
  'invoice_created',
  'invoice_finalized',
  'invoice_voided',
  'invoice_restatement_issued',
  'invoice_note_added'
);

-- ─── Table: invoice_ledger_entries ───────────────────────────────────────────

create table public.invoice_ledger_entries (
  id              uuid                        not null default gen_random_uuid(),

  invoice_id      uuid                        not null references public.monthly_invoices (id),
  year_month      text                        not null,
  period_start    date                        not null,
  period_end      date                        not null,

  event           public.invoice_ledger_event not null,
  from_status     public.invoice_status,
  to_status       public.invoice_status,

  reason          text,
  metadata        jsonb,

  actor_id        uuid                        not null references auth.users (id),
  occurred_at     timestamptz                 not null default now(),

  constraint invoice_ledger_entries_pkey
    primary key (id),

  constraint invoice_ledger_entries_period_ordered
    check (period_end >= period_start),

  constraint invoice_ledger_entries_year_month_format
    check (year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  -- Event transition semantics
  constraint invoice_ledger_entries_transition_consistent
    check (
      (
        event = 'invoice_created'
        and from_status is null
        and to_status = 'draft'
      )
      or
      (
        event = 'invoice_finalized'
        and from_status = 'draft'
        and to_status = 'finalized'
      )
      or
      (
        event = 'invoice_voided'
        and from_status in ('draft', 'finalized')
        and to_status = 'voided'
      )
      or
      (
        event in ('invoice_restatement_issued', 'invoice_note_added')
        and from_status is null
        and to_status is null
      )
    ),

  -- reason required for void/restatement events.
  constraint invoice_ledger_entries_reason_required
    check (
      event not in ('invoice_voided', 'invoice_restatement_issued')
      or (reason is not null and btrim(reason) <> '')
    )
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

create index invoice_ledger_entries_invoice_occurred_idx
  on public.invoice_ledger_entries (invoice_id, occurred_at desc);

create index invoice_ledger_entries_period_occurred_idx
  on public.invoice_ledger_entries (period_start desc, occurred_at desc);

create index invoice_ledger_entries_event_occurred_idx
  on public.invoice_ledger_entries (event, occurred_at desc);

-- ─── Append-only guard ───────────────────────────────────────────────────────

create or replace function public.prevent_invoice_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    '[GTG] invoice_ledger_entries is append-only. % is not allowed for id=%.',
    tg_op, coalesce(new.id, old.id);
end;
$$;

create trigger invoice_ledger_entries_append_only_guard
  before update or delete
  on public.invoice_ledger_entries
  for each row
  execute function public.prevent_invoice_ledger_mutation();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table public.invoice_ledger_entries enable row level security;

create policy "invoice_ledger_entries_select_privileged"
  on public.invoice_ledger_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

create policy "invoice_ledger_entries_insert_admin"
  on public.invoice_ledger_entries
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE/DELETE policies intentionally omitted (append-only).

comment on table public.invoice_ledger_entries is
  'Immutable invoice lifecycle ledger. Records invoice creation, finalization, '
  'voiding, and restatement events with actor and timestamp for financial audit.';

