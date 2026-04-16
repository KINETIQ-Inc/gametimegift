-- =============================================================================
-- Migration: 20260307000055_foreign_keys_hardening
--
-- Phase 4C-2: Foreign keys
-- Objective:
--   - Add missing FK-style integrity guarantees for denormalized ledger columns.
--   - Enforce parent-child consistency beyond single-column id references.
-- =============================================================================

-- ─── fraud_ledger_entries: (fraud_flag_id, unit_id) must match fraud_flags ──
-- fraud_ledger_entries already has separate FKs to fraud_flags.id and unit_id.
-- This composite FK ensures those two values belong to the SAME fraud_flags row.

create unique index if not exists fraud_flags_id_unit_id_uidx
  on public.fraud_flags (id, unit_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fraud_ledger_entries_flag_unit_fkey'
      and conrelid = 'public.fraud_ledger_entries'::regclass
  ) then
    alter table public.fraud_ledger_entries
      add constraint fraud_ledger_entries_flag_unit_fkey
        foreign key (fraud_flag_id, unit_id)
        references public.fraud_flags (id, unit_id);
  end if;
end $$;

-- ─── invoice_ledger_entries: invoice period fields must match monthly_invoices ─
-- invoice_ledger_entries stores denormalized year/month + period bounds.
-- This composite FK guarantees those values are consistent with invoice_id.

create unique index if not exists monthly_invoices_id_period_uidx
  on public.monthly_invoices (id, year_month, period_start, period_end);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_ledger_entries_invoice_period_fkey'
      and conrelid = 'public.invoice_ledger_entries'::regclass
  ) then
    alter table public.invoice_ledger_entries
      add constraint invoice_ledger_entries_invoice_period_fkey
        foreign key (invoice_id, year_month, period_start, period_end)
        references public.monthly_invoices (id, year_month, period_start, period_end);
  end if;
end $$;

