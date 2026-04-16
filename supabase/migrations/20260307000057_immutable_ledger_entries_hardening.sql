-- =============================================================================
-- Migration: 20260307000057_immutable_ledger_entries_hardening
--
-- Phase 4C-4: Immutable ledger entries
-- Objective:
--   - Enforce trigger-level immutability on append-only ledger tables.
--   - Protect against service-role updates/deletes that bypass RLS.
-- =============================================================================

-- Generic append-only guard for ledger tables.
create or replace function public.prevent_append_only_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    '[GTG] % is append-only. % is not allowed for id=%.',
    tg_table_name, tg_op, coalesce(new.id, old.id);
end;
$$;

-- ─── payment_events (missing trigger-level guard) ───────────────────────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'payment_events_append_only_guard'
      and tgrelid = 'public.payment_events'::regclass
  ) then
    create trigger payment_events_append_only_guard
      before update or delete
      on public.payment_events
      for each row
      execute function public.prevent_append_only_ledger_mutation();
  end if;
end $$;

-- ─── inventory_ledger_entries (already guarded; ensure present) ─────────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'inventory_ledger_entries_append_only_guard'
      and tgrelid = 'public.inventory_ledger_entries'::regclass
  ) then
    create trigger inventory_ledger_entries_append_only_guard
      before update or delete
      on public.inventory_ledger_entries
      for each row
      execute function public.prevent_append_only_ledger_mutation();
  end if;
end $$;

-- ─── fraud_ledger_entries (already guarded; ensure present) ─────────────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'fraud_ledger_entries_append_only_guard'
      and tgrelid = 'public.fraud_ledger_entries'::regclass
  ) then
    create trigger fraud_ledger_entries_append_only_guard
      before update or delete
      on public.fraud_ledger_entries
      for each row
      execute function public.prevent_append_only_ledger_mutation();
  end if;
end $$;

-- ─── invoice_ledger_entries (already guarded; ensure present) ───────────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'invoice_ledger_entries_append_only_guard'
      and tgrelid = 'public.invoice_ledger_entries'::regclass
  ) then
    create trigger invoice_ledger_entries_append_only_guard
      before update or delete
      on public.invoice_ledger_entries
      for each row
      execute function public.prevent_append_only_ledger_mutation();
  end if;
end $$;

