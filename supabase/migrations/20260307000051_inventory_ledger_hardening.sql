-- =============================================================================
-- Migration: 20260307000051_inventory_ledger_hardening
--
-- Phase 4B-1: inventory_ledger
-- Objective:
--   - Enforce strict append-only behavior at the DB layer.
--   - Harden action-context constraints for ledger row integrity.
-- =============================================================================

-- ─── Append-only guard (UPDATE/DELETE forbidden) ────────────────────────────
-- RLS already omits UPDATE/DELETE policies, but service_role bypasses RLS.
-- This trigger enforces append-only semantics for all roles.

create or replace function public.prevent_inventory_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    '[GTG] inventory_ledger_entries is append-only. % is not allowed for id=%.',
    tg_op, coalesce(new.id, old.id);
end;
$$;

drop trigger if exists inventory_ledger_entries_append_only_guard
  on public.inventory_ledger_entries;

create trigger inventory_ledger_entries_append_only_guard
  before update or delete
  on public.inventory_ledger_entries
  for each row
  execute function public.prevent_inventory_ledger_mutation();

-- ─── Action-context constraints ──────────────────────────────────────────────

-- order_id context:
--   required for reserved/reservation_released/sold/returned
--   must be null for all other actions
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inventory_ledger_entries_order_context_consistent'
      and conrelid = 'public.inventory_ledger_entries'::regclass
  ) then
    alter table public.inventory_ledger_entries
      add constraint inventory_ledger_entries_order_context_consistent
      check (
        (
          action in ('reserved', 'reservation_released', 'sold', 'returned')
          and order_id is not null
        )
        or
        (
          action not in ('reserved', 'reservation_released', 'sold', 'returned')
          and order_id is null
        )
      );
  end if;
end $$;

-- retail_price_cents context:
--   required for sold/returned
--   must be null for all other actions
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inventory_ledger_entries_retail_context_consistent'
      and conrelid = 'public.inventory_ledger_entries'::regclass
  ) then
    alter table public.inventory_ledger_entries
      add constraint inventory_ledger_entries_retail_context_consistent
      check (
        (
          action in ('sold', 'returned')
          and retail_price_cents is not null
        )
        or
        (
          action not in ('sold', 'returned')
          and retail_price_cents is null
        )
      );
  end if;
end $$;

-- consultant_id context:
--   optional for sold/returned (direct sales may be null)
--   must be null for all other actions
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inventory_ledger_entries_consultant_context_consistent'
      and conrelid = 'public.inventory_ledger_entries'::regclass
  ) then
    alter table public.inventory_ledger_entries
      add constraint inventory_ledger_entries_consultant_context_consistent
      check (
        (
          action in ('sold', 'returned')
        )
        or
        (
          action not in ('sold', 'returned')
          and consultant_id is null
        )
      );
  end if;
end $$;

-- reason quality:
--   existing constraint already requires reason for fraud_locked/fraud_released/voided
--   this adds non-blank enforcement.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inventory_ledger_entries_reason_nonblank_when_required'
      and conrelid = 'public.inventory_ledger_entries'::regclass
  ) then
    alter table public.inventory_ledger_entries
      add constraint inventory_ledger_entries_reason_nonblank_when_required
      check (
        action not in ('fraud_locked', 'fraud_released', 'voided')
        or btrim(reason) <> ''
      );
  end if;
end $$;

