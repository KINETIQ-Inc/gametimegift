-- =============================================================================
-- Migration: 20260307000056_state_machine_checks_hardening
--
-- Phase 4C-3: State machine checks
-- Objective:
--   - Add DB-level status/field consistency checks that complement transition
--     triggers (migration 18).
--   - Ensure lifecycle statuses require their corresponding timestamps/reasons.
-- =============================================================================

-- ─── orders: status ↔ lifecycle timestamp consistency ───────────────────────

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_status_lifecycle_consistent'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_status_lifecycle_consistent
      check (
        -- Paid pipeline states require paid_at.
        (
          status in ('paid', 'fulfilling', 'fulfilled', 'partially_returned', 'fully_returned', 'refunded')
          and paid_at is not null
        )
        or
        (
          status in ('draft', 'pending_payment', 'payment_failed', 'cancelled')
          and paid_at is null
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_fulfillment_timestamp_consistent'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_fulfillment_timestamp_consistent
      check (
        (
          status in ('fulfilled', 'partially_returned', 'fully_returned')
          and fulfilled_at is not null
        )
        or
        (
          status not in ('fulfilled', 'partially_returned', 'fully_returned')
          and fulfilled_at is null
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_closed_timestamp_consistent'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_closed_timestamp_consistent
      check (
        (
          status in ('cancelled', 'refunded', 'fully_returned')
          and closed_at is not null
        )
        or
        (
          status not in ('cancelled', 'refunded', 'fully_returned')
          and closed_at is null
        )
      );
  end if;
end $$;

-- ─── commission_entries: status ↔ approval/payment/reversal fields ──────────

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'commission_entries_status_fields_consistent'
      and conrelid = 'public.commission_entries'::regclass
  ) then
    alter table public.commission_entries
      add constraint commission_entries_status_fields_consistent
      check (
        -- approved/paid must have approval attribution
        (
          status in ('approved', 'paid')
          and approved_at is not null
          and approved_by is not null
        )
        or
        (
          status not in ('approved', 'paid')
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'commission_entries_paid_timestamp_required'
      and conrelid = 'public.commission_entries'::regclass
  ) then
    alter table public.commission_entries
      add constraint commission_entries_paid_timestamp_required
      check (
        (status = 'paid' and paid_at is not null)
        or
        (status != 'paid' and paid_at is null)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'commission_entries_reversed_timestamp_required'
      and conrelid = 'public.commission_entries'::regclass
  ) then
    alter table public.commission_entries
      add constraint commission_entries_reversed_timestamp_required
      check (
        (status = 'reversed' and reversed_at is not null)
        or
        (status != 'reversed' and reversed_at is null)
      );
  end if;
end $$;

-- ─── fraud_flags: status ↔ assignment/escalation/resolution fields ──────────

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fraud_flags_status_assignment_consistent'
      and conrelid = 'public.fraud_flags'::regclass
  ) then
    alter table public.fraud_flags
      add constraint fraud_flags_status_assignment_consistent
      check (
        (status = 'open' and assigned_to is null and assigned_at is null)
        or
        (status in ('under_review', 'escalated', 'confirmed', 'dismissed') and assigned_to is not null and assigned_at is not null)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fraud_flags_escalation_reason_required'
      and conrelid = 'public.fraud_flags'::regclass
  ) then
    alter table public.fraud_flags
      add constraint fraud_flags_escalation_reason_required
      check (
        status != 'escalated'
        or (escalation_reason is not null and btrim(escalation_reason) <> '')
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fraud_flags_resolution_required_for_terminal'
      and conrelid = 'public.fraud_flags'::regclass
  ) then
    alter table public.fraud_flags
      add constraint fraud_flags_resolution_required_for_terminal
      check (
        (
          status in ('confirmed', 'dismissed')
          and resolved_at is not null
          and resolved_by is not null
          and resolution_note is not null
          and btrim(resolution_note) <> ''
        )
        or
        (
          status not in ('confirmed', 'dismissed')
          and resolved_at is null
          and resolved_by is null
          and resolution_note is null
        )
      );
  end if;
end $$;

-- ─── monthly_invoices: status ↔ finalize/void fields ────────────────────────

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'monthly_invoices_status_lifecycle_consistent'
      and conrelid = 'public.monthly_invoices'::regclass
  ) then
    alter table public.monthly_invoices
      add constraint monthly_invoices_status_lifecycle_consistent
      check (
        (
          status = 'draft'
          and finalized_at is null
          and finalized_by is null
          and voided_at is null
          and voided_by is null
          and void_reason is null
        )
        or
        (
          status = 'finalized'
          and finalized_at is not null
          and finalized_by is not null
          and voided_at is null
          and voided_by is null
          and void_reason is null
        )
        or
        (
          status = 'voided'
          and voided_at is not null
          and voided_by is not null
          and void_reason is not null
          and btrim(void_reason) <> ''
        )
      );
  end if;
end $$;

