-- =============================================================================
-- Migration: 20260305000025_apply_fraud_auto_lock_fn
--
-- Creates:
--   function public.apply_fraud_auto_lock   policy-driven unit lock from flag
--
-- ─── Background ──────────────────────────────────────────────────────────────
--
-- Auto-lock policy:
--   A fraud_flag with severity 'high' or 'critical' must be accompanied by
--   a unit lock. Flags with severity 'low' or 'medium' are informational —
--   they enter the investigation queue but do not immediately restrict the unit.
--
-- This function is the single enforcer of that policy. All signal-specific
-- detection paths (detect-duplicate-serials, future hologram-scan-fail, etc.)
-- may call this function rather than re-implementing the severity check and
-- lock_unit() call themselves. flag_duplicate_serial inlines the same logic
-- for atomicity within its own transaction; apply_fraud_auto_lock provides
-- the same guarantee for any flag created without an initial lock.
--
-- Primary use cases:
--   1. A flag was created for a unit that was already fraud_locked at signal
--      time (auto-lock could not be applied). Once the existing lock is
--      released, the admin runs apply_fraud_auto_lock to re-apply.
--
--   2. A flag was created manually (source = 'admin_manual') or via a signal
--      source that does not auto-lock (consultant_report, customer_report)
--      and an investigator later escalates it to severity = 'high' or 'critical'.
--      apply_fraud_auto_lock is then called to enforce the updated severity rule.
--
--   3. A new fraud signal path is added. Rather than embedding the auto-lock
--      logic in each new detection function, the caller creates the flag and
--      then calls apply_fraud_auto_lock.
--
-- ─── Idempotency ─────────────────────────────────────────────────────────────
--
-- If fraud_flag.auto_locked = true, the function returns the existing
-- auto_lock_id with was_locked = false — no second lock is applied.
-- This makes the call safe to retry without risk of double-locking.
--
-- ─── Transaction safety ──────────────────────────────────────────────────────
--
-- The function acquires SELECT FOR UPDATE on the serialized_units row before
-- the status check and before calling lock_unit(). lock_unit() issues its own
-- SELECT FOR UPDATE — within the same transaction this is a no-op, and
-- lock_unit() reads the correct pre-lock status.
-- =============================================================================

create or replace function public.apply_fraud_auto_lock(
  p_fraud_flag_id  uuid,
  p_applied_by     uuid
)
returns table (
  lock_record_id  uuid,
  was_locked      boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flag            record;
  v_unit_status     public.unit_status;
  v_lock_record_id  uuid;
begin

  -- ── Validate required parameters ──────────────────────────────────────────
  if p_fraud_flag_id is null then
    raise exception '[GTG] apply_fraud_auto_lock: p_fraud_flag_id is required.';
  end if;
  if p_applied_by is null then
    raise exception '[GTG] apply_fraud_auto_lock: p_applied_by is required.';
  end if;

  -- ── Fetch fraud flag ──────────────────────────────────────────────────────
  -- No FOR UPDATE on fraud_flags — only the unit row needs row-level locking.
  select
    id,
    unit_id,
    severity,
    status,
    auto_locked,
    auto_lock_id,
    description
  into v_flag
  from public.fraud_flags
  where id = p_fraud_flag_id;

  if not found then
    raise exception '[GTG] apply_fraud_auto_lock: fraud_flag not found (id=%).', p_fraud_flag_id;
  end if;

  -- ── Policy check: severity must be high or critical ───────────────────────
  -- low and medium flags are informational; they do not lock units.
  if v_flag.severity not in ('high', 'critical') then
    raise exception
      '[GTG] apply_fraud_auto_lock: severity ''%'' does not trigger an auto-lock. '
      'Only high and critical flags auto-lock units. '
      'If the severity has been escalated, update the flag before calling this function.',
      v_flag.severity;
  end if;

  -- ── Terminal flag guard ────────────────────────────────────────────────────
  -- Confirmed and dismissed flags are closed — no further action is taken.
  if v_flag.status in ('confirmed', 'dismissed') then
    raise exception
      '[GTG] apply_fraud_auto_lock: fraud_flag ''%'' has status ''%'' and is terminal. '
      'Auto-lock applies only to open, under_review, and escalated flags.',
      p_fraud_flag_id, v_flag.status;
  end if;

  -- ── Idempotency: already locked ───────────────────────────────────────────
  if v_flag.auto_locked = true then
    return query select v_flag.auto_lock_id, false;
    return;
  end if;

  -- ── Row-lock the unit ─────────────────────────────────────────────────────
  -- Must acquire the lock before reading status to prevent TOCTOU.
  -- lock_unit() will issue its own FOR UPDATE on the same row; within this
  -- transaction that re-acquisition is a no-op.
  select status into v_unit_status
  from public.serialized_units
  where id = v_flag.unit_id
  for update;

  if not found then
    raise exception
      '[GTG] apply_fraud_auto_lock: unit ''%'' referenced by fraud_flag ''%'' not found.',
      v_flag.unit_id, p_fraud_flag_id;
  end if;

  -- ── Lockable status check ─────────────────────────────────────────────────
  -- fraud_locked: unit already under lock control — no second lock needed.
  -- voided: terminal status — cannot be locked.
  if v_unit_status not in ('available', 'reserved', 'sold', 'returned') then
    raise exception
      '[GTG] apply_fraud_auto_lock: unit has status ''%'' and cannot be auto-locked. '
      'fraud_locked units are already controlled; voided units are terminal. '
      'Release the existing lock before applying a new one.',
      v_unit_status;
  end if;

  -- ── Apply lock via lock_unit() ────────────────────────────────────────────
  -- lock_authority = 'system': automated lock triggered by severity rule.
  -- licensor_reference_id = null: not a licensor-mandated lock.
  -- p_fraud_flag_id is passed so the resulting lock_records row links back
  -- to this flag (lock_records.fraud_flag_id).
  select lr.lock_record_id into v_lock_record_id
  from public.lock_unit(
    v_flag.unit_id,
    p_applied_by,
    'Fraud auto-lock (flag_id=' || p_fraud_flag_id::text || ', severity=' || v_flag.severity::text || '): '
      || v_flag.description,
    'system',
    p_fraud_flag_id,
    null
  ) lr;

  -- ── Wire lock reference back onto the flag ────────────────────────────────
  update public.fraud_flags
  set
    auto_locked  = true,
    auto_lock_id = v_lock_record_id
  where id = p_fraud_flag_id;

  return query select v_lock_record_id, true;

end;
$$;

grant execute on function public.apply_fraud_auto_lock(uuid, uuid)
  to service_role;

comment on function public.apply_fraud_auto_lock(uuid, uuid) is
  'Applies an automatic unit lock to a fraud_flag when severity policy requires it. '
  'Policy: severity ''high'' or ''critical'' → lock under system authority. '
  'Idempotent: returns existing lock_record_id if auto_locked = true already. '
  'Guards: flag must be non-terminal; unit must be in a lockable status. '
  'Called by the apply-fraud-auto-lock Edge Function and any future detection '
  'path that creates flags without inlining the lock step.';
