-- =============================================================================
-- Migration: 20260307000052_create_fraud_ledger_entries
--
-- Phase 4B-4: fraud_ledger
-- Objective:
--   - Create immutable fraud ledger table for investigation/audit events.
--   - Enforce event-level integrity and strict append-only behavior.
-- =============================================================================

-- ─── Enum: fraud_ledger_event ────────────────────────────────────────────────

create type public.fraud_ledger_event as enum (
  'flag_created',
  'assigned',
  'status_changed',
  'escalated',
  'confirmed',
  'dismissed',
  'lock_applied',
  'lock_released',
  'note_added'
);

-- ─── Table: fraud_ledger_entries ─────────────────────────────────────────────

create table public.fraud_ledger_entries (
  id                  uuid                      not null default gen_random_uuid(),

  -- Primary fraud investigation linkage
  fraud_flag_id       uuid                      not null references public.fraud_flags (id),
  -- Optional lock linkage for lock events
  lock_record_id      uuid                      references public.lock_records (id),

  -- Denormalized/linked context
  unit_id             uuid                      not null references public.serialized_units (id),
  order_id            uuid                      references public.orders (id),
  consultant_id       uuid                      references public.consultant_profiles (id),

  -- Event payload
  event               public.fraud_ledger_event not null,
  from_status         public.fraud_flag_status,
  to_status           public.fraud_flag_status,
  severity            public.fraud_flag_severity,
  reason              text,
  metadata            jsonb,

  -- Actor and time
  actor_id            uuid                      not null references auth.users (id),
  occurred_at         timestamptz               not null default now(),

  constraint fraud_ledger_entries_pkey
    primary key (id),

  -- lock_record_id is required for lock events and disallowed otherwise.
  constraint fraud_ledger_entries_lock_event_consistent
    check (
      (
        event in ('lock_applied', 'lock_released')
        and lock_record_id is not null
      )
      or
      (
        event not in ('lock_applied', 'lock_released')
        and lock_record_id is null
      )
    ),

  -- Status transition fields:
  -- For status_changed, both from/to are required and must differ.
  -- For non-status_changed events, both fields must be null.
  constraint fraud_ledger_entries_status_transition_consistent
    check (
      (
        event = 'status_changed'
        and from_status is not null
        and to_status is not null
        and from_status <> to_status
      )
      or
      (
        event <> 'status_changed'
        and from_status is null
        and to_status is null
      )
    ),

  -- reason required for escalation/dismissal/lock lifecycle events.
  constraint fraud_ledger_entries_reason_required
    check (
      event not in ('escalated', 'dismissed', 'lock_applied', 'lock_released')
      or (reason is not null and btrim(reason) <> '')
    )
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

create index fraud_ledger_entries_flag_occurred_idx
  on public.fraud_ledger_entries (fraud_flag_id, occurred_at desc);

create index fraud_ledger_entries_unit_occurred_idx
  on public.fraud_ledger_entries (unit_id, occurred_at desc);

create index fraud_ledger_entries_event_occurred_idx
  on public.fraud_ledger_entries (event, occurred_at desc);

create index fraud_ledger_entries_lock_record_idx
  on public.fraud_ledger_entries (lock_record_id)
  where lock_record_id is not null;

-- ─── Append-only guard ───────────────────────────────────────────────────────

create or replace function public.prevent_fraud_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    '[GTG] fraud_ledger_entries is append-only. % is not allowed for id=%.',
    tg_op, coalesce(new.id, old.id);
end;
$$;

create trigger fraud_ledger_entries_append_only_guard
  before update or delete
  on public.fraud_ledger_entries
  for each row
  execute function public.prevent_fraud_ledger_mutation();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table public.fraud_ledger_entries enable row level security;

create policy "fraud_ledger_entries_select_privileged"
  on public.fraud_ledger_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

create policy "fraud_ledger_entries_insert_admin"
  on public.fraud_ledger_entries
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE/DELETE policies intentionally omitted (append-only).

comment on table public.fraud_ledger_entries is
  'Immutable fraud investigation audit ledger. One row per significant fraud event '
  '(flag lifecycle actions, lock lifecycle actions, investigator notes). '
  'No UPDATE or DELETE permitted.';

