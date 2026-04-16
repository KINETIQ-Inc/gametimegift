-- =============================================================================
-- Migration: 20260305000018_status_state_machine_constraints
--
-- Enforces valid status transitions via BEFORE UPDATE triggers on every table
-- that carries a lifecycle status column. Invalid transitions are rejected with
-- a named exception before any data is written.
--
-- Tables covered:
--   serialized_units       unit_status          (7 triggers)
--   orders                 order_status         (10 states)
--   order_lines            order_line_status    (5 states)
--   consultant_profiles    consultant_status    (4 states)
--   commission_entries     commission_status    (6 states)
--   fraud_flags            fraud_flag_status    (5 states)
--   lock_records           is_active bool       (release is irreversible)
--
-- Each trigger:
--   1. Passes through immediately if the status column did not change.
--   2. Raises an exception if the (old.status → new.status) pair is not in the
--      allowed set for that table.
--
-- Transition authority:
--   Every allowed transition is derived from the state machine comments in
--   packages/types/src/. If a transition is not listed in those comments, it
--   is rejected here. Adding a new transition requires updating BOTH the
--   TypeScript type file AND this migration (in a new migration that alters
--   the trigger function).
--
-- Corrective admin updates:
--   Legitimate status corrections (e.g., fixing a bug-induced bad state) must
--   be performed via a SECURITY DEFINER function that sets the session variable
--   app.bypass_status_checks = 'true' before the corrective UPDATE. Each
--   trigger checks this setting and passes through when it is set. The bypass
--   is intentionally not active by default — it must be explicitly invoked
--   and is logged via the calling function's audit trail.
-- =============================================================================

-- ─── Bypass helper ────────────────────────────────────────────────────────────
-- Centralizes the bypass check so all triggers call the same function.
-- Returns true when app.bypass_status_checks = 'true' is set for this session.

create or replace function public.status_check_bypassed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_setting('app.bypass_status_checks', true) = 'true';
$$;


-- =============================================================================
-- 1. serialized_units.status  (unit_status)
--
-- Canonical state machine (from packages/types/src/inventory.ts):
--
--   available    → reserved, fraud_locked, voided
--   reserved     → available, sold, fraud_locked, voided
--   sold         → returned, fraud_locked, voided
--   fraud_locked → available, voided
--   returned     → available, voided
--   voided       → (terminal — no outbound transitions)
-- =============================================================================

create or replace function public.enforce_unit_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'available'    and new.status in ('reserved', 'fraud_locked', 'voided'))
    or (old.status = 'reserved'     and new.status in ('available', 'sold', 'fraud_locked', 'voided'))
    or (old.status = 'sold'         and new.status in ('returned', 'fraud_locked', 'voided'))
    or (old.status = 'fraud_locked' and new.status in ('available', 'voided'))
    or (old.status = 'returned'     and new.status in ('available', 'voided'))
    -- 'voided' is terminal; no outbound transitions
  ) then
    raise exception
      '[GTG] Invalid unit status transition: ''%'' → ''%''. '
      'Unit id=%. See UnitStatus in packages/types/src/inventory.ts for valid transitions.',
      old.status, new.status, old.id;
  end if;

  return new;
end;
$$;

create trigger serialized_units_enforce_status_transition
  before update of status on public.serialized_units
  for each row
  execute function public.enforce_unit_status_transition();


-- =============================================================================
-- 2. orders.status  (order_status)
--
-- Canonical state machine (from packages/types/src/orders.ts):
--
--   draft             → pending_payment, cancelled
--   pending_payment   → paid, payment_failed, cancelled
--   payment_failed    → pending_payment, cancelled
--   paid              → fulfilling, partially_returned, refunded
--   fulfilling        → fulfilled, partially_returned, refunded
--   fulfilled         → partially_returned, fully_returned
--   partially_returned → fully_returned, refunded
--   fully_returned    → refunded
--   refunded          → (terminal)
--   cancelled         → (terminal)
--
-- Note: 'cancelled' is only reachable from pre-payment states
-- (draft, pending_payment, payment_failed). Orders that have been paid
-- cannot be cancelled — they must be refunded.
-- =============================================================================

create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'draft'              and new.status in ('pending_payment', 'cancelled'))
    or (old.status = 'pending_payment'   and new.status in ('paid', 'payment_failed', 'cancelled'))
    or (old.status = 'payment_failed'    and new.status in ('pending_payment', 'cancelled'))
    or (old.status = 'paid'             and new.status in ('fulfilling', 'partially_returned', 'refunded'))
    or (old.status = 'fulfilling'       and new.status in ('fulfilled', 'partially_returned', 'refunded'))
    or (old.status = 'fulfilled'        and new.status in ('partially_returned', 'fully_returned'))
    or (old.status = 'partially_returned' and new.status in ('fully_returned', 'refunded'))
    or (old.status = 'fully_returned'   and new.status in ('refunded'))
    -- 'refunded' and 'cancelled' are terminal
  ) then
    raise exception
      '[GTG] Invalid order status transition: ''%'' → ''%''. '
      'Order id=%, order_number=%. See OrderStatus in packages/types/src/orders.ts.',
      old.status, new.status, old.id, old.order_number;
  end if;

  return new;
end;
$$;

create trigger orders_enforce_status_transition
  before update of status on public.orders
  for each row
  execute function public.enforce_order_status_transition();


-- =============================================================================
-- 3. order_lines.status  (order_line_status)
--
-- Canonical state machine (from packages/types/src/orders.ts):
--
--   reserved  → shipped, cancelled
--   shipped   → delivered, returned
--   delivered → returned
--   returned  → (terminal)
--   cancelled → (terminal)
-- =============================================================================

create or replace function public.enforce_order_line_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'reserved'  and new.status in ('shipped', 'cancelled'))
    or (old.status = 'shipped'   and new.status in ('delivered', 'returned'))
    or (old.status = 'delivered' and new.status in ('returned'))
    -- 'returned' and 'cancelled' are terminal
  ) then
    raise exception
      '[GTG] Invalid order line status transition: ''%'' → ''%''. '
      'OrderLine id=%, order_id=%. See OrderLineStatus in packages/types/src/orders.ts.',
      old.status, new.status, old.id, old.order_id;
  end if;

  return new;
end;
$$;

create trigger order_lines_enforce_status_transition
  before update of status on public.order_lines
  for each row
  execute function public.enforce_order_line_status_transition();


-- =============================================================================
-- 4. consultant_profiles.status  (consultant_status)
--
-- Canonical state machine (from packages/types/src/consultant.ts):
--
--   pending_approval → active, terminated
--   active           → suspended, terminated
--   suspended        → active, terminated
--   terminated       → (terminal)
-- =============================================================================

create or replace function public.enforce_consultant_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'pending_approval' and new.status in ('active', 'terminated'))
    or (old.status = 'active'          and new.status in ('suspended', 'terminated'))
    or (old.status = 'suspended'       and new.status in ('active', 'terminated'))
    -- 'terminated' is terminal
  ) then
    raise exception
      '[GTG] Invalid consultant status transition: ''%'' → ''%''. '
      'ConsultantProfile id=%. See ConsultantStatus in packages/types/src/consultant.ts.',
      old.status, new.status, old.id;
  end if;

  return new;
end;
$$;

create trigger consultant_profiles_enforce_status_transition
  before update of status on public.consultant_profiles
  for each row
  execute function public.enforce_consultant_status_transition();


-- =============================================================================
-- 5. commission_entries.status  (commission_status)
--
-- Canonical state machine (from packages/types/src/consultant.ts):
--
--   earned   → held, approved, reversed, voided
--   held     → approved, reversed, voided
--   approved → paid, reversed, voided
--   paid     → reversed
--   reversed → (terminal)
--   voided   → (terminal)
--
-- Note: 'voided' is reachable from any non-terminal state ('any → voided'
-- for system corrections). 'reversed' is reachable from earned, held, approved,
-- paid (post-payment clawback is rare but legally required for confirmed fraud).
-- =============================================================================

create or replace function public.enforce_commission_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'earned'   and new.status in ('held', 'approved', 'reversed', 'voided'))
    or (old.status = 'held'     and new.status in ('approved', 'reversed', 'voided'))
    or (old.status = 'approved' and new.status in ('paid', 'reversed', 'voided'))
    or (old.status = 'paid'     and new.status in ('reversed'))
    -- 'reversed' and 'voided' are terminal
  ) then
    raise exception
      '[GTG] Invalid commission status transition: ''%'' → ''%''. '
      'CommissionEntry id=%, unit_id=%. See CommissionStatus in packages/types/src/consultant.ts.',
      old.status, new.status, old.id, old.unit_id;
  end if;

  return new;
end;
$$;

create trigger commission_entries_enforce_status_transition
  before update of status on public.commission_entries
  for each row
  execute function public.enforce_commission_status_transition();


-- =============================================================================
-- 6. fraud_flags.status  (fraud_flag_status)
--
-- Canonical state machine (from packages/types/src/fraud.ts):
--
--   open         → under_review, confirmed, dismissed
--   under_review → escalated, confirmed, dismissed
--   escalated    → confirmed, dismissed
--   confirmed    → (terminal)
--   dismissed    → (terminal)
-- =============================================================================

create or replace function public.enforce_fraud_flag_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'open'         and new.status in ('under_review', 'confirmed', 'dismissed'))
    or (old.status = 'under_review' and new.status in ('escalated', 'confirmed', 'dismissed'))
    or (old.status = 'escalated'    and new.status in ('confirmed', 'dismissed'))
    -- 'confirmed' and 'dismissed' are terminal
  ) then
    raise exception
      '[GTG] Invalid fraud flag status transition: ''%'' → ''%''. '
      'FraudFlag id=%, unit_id=%. See FraudFlagStatus in packages/types/src/fraud.ts.',
      old.status, new.status, old.id, old.unit_id;
  end if;

  return new;
end;
$$;

create trigger fraud_flags_enforce_status_transition
  before update of status on public.fraud_flags
  for each row
  execute function public.enforce_fraud_flag_status_transition();


-- =============================================================================
-- 7. lock_records.is_active  (boolean — release is irreversible)
--
-- Once a lock is released (is_active = false), it may never be re-activated.
-- Re-locking the same target requires a new lock_records row.
-- This constraint enforces the append-only-with-release semantic.
-- =============================================================================

create or replace function public.enforce_lock_release_irreversible()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.status_check_bypassed() then return new; end if;

  if old.is_active = false and new.is_active = true then
    raise exception
      '[GTG] Lock record cannot be re-activated after release. '
      'LockRecord id=%. To re-lock the target, create a new lock_records row.',
      old.id;
  end if;

  return new;
end;
$$;

create trigger lock_records_enforce_release_irreversible
  before update of is_active on public.lock_records
  for each row
  execute function public.enforce_lock_release_irreversible();
