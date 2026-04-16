-- =============================================================================
-- Migration: 20260305000024_duplicate_serial_fns
--
-- Creates:
--   function public.find_duplicate_serial_unit_ids   detection query
--   function public.flag_duplicate_serial             atomic flag + auto-lock
--
-- ─── Background ──────────────────────────────────────────────────────────────
--
-- "Duplicate serial" means the same physical unit has been sold more times than
-- legitimate return-and-resale can explain.
--
-- A unit sold once and returned may legally be resold. The invariant is:
--
--   count(sold) <= count(returned) + 1
--
-- Any unit where count(sold) > count(returned) + 1 has been sold more times
-- than the return history accounts for — indicating a double-sale, a bug in
-- the order pipeline, or active fraud.
--
-- Examples:
--   sold=1, returned=0 → 1 > 1 → false  (normal: one sale, no return yet)
--   sold=2, returned=1 → 2 > 2 → false  (legitimate: sold, returned, resold)
--   sold=2, returned=0 → 2 > 1 → TRUE   (fraud: double-sold without return)
--   sold=3, returned=1 → 3 > 2 → TRUE   (fraud: sold 3x but returned only once)
--
-- ─── Auto-lock policy ────────────────────────────────────────────────────────
--
-- Duplicate serial is classified as severity='high' (72-hour investigator SLA).
-- Severity high and critical trigger an automatic unit lock (lock_authority='system').
-- The flag_duplicate_serial function applies the lock atomically by calling
-- the existing lock_unit() function with the new fraud_flag_id, then wires
-- fraud_flags.auto_lock_id back to the resulting lock_records.id.
-- =============================================================================

-- ─── Function 1: find_duplicate_serial_unit_ids ───────────────────────────────
-- Scans inventory_ledger_entries to find units with sold_count > returned_count + 1.
--
-- Parameters:
--   p_unit_ids  uuid[]  — restrict to these unit IDs; NULL = scan all units
--
-- Returns:
--   unit_id       uuid    — serialized_units.id
--   serial_number text    — denormalized for display
--   sold_count    bigint  — count of 'sold' ledger actions
--   returned_count bigint — count of 'returned' ledger actions
--
-- Performance note:
--   The query uses inventory_ledger_entries_unit_id_idx. In scan mode (p_unit_ids
--   IS NULL) the full ledger is scanned — this is expected for a periodic admin
--   job. In targeted mode the index seek limits the scan to the provided units.

create or replace function public.find_duplicate_serial_unit_ids(
  p_unit_ids  uuid[]  default null
)
returns table (
  unit_id        uuid,
  serial_number  text,
  sold_count     bigint,
  returned_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    su.id                                                   as unit_id,
    su.serial_number,
    count(*) filter (where ile.action = 'sold')             as sold_count,
    count(*) filter (where ile.action = 'returned')         as returned_count
  from public.inventory_ledger_entries ile
  join public.serialized_units su
    on su.id = ile.unit_id
  where ile.action in ('sold', 'returned')
    and (p_unit_ids is null or ile.unit_id = any(p_unit_ids))
  group by su.id, su.serial_number
  having count(*) filter (where ile.action = 'sold')
       > count(*) filter (where ile.action = 'returned') + 1
  order by su.serial_number;
$$;

grant execute on function public.find_duplicate_serial_unit_ids(uuid[])
  to service_role;

comment on function public.find_duplicate_serial_unit_ids(uuid[]) is
  'Detection query for duplicate-serial fraud signals. Returns units where '
  'count(sold ledger actions) > count(returned ledger actions) + 1. '
  'Pass p_unit_ids to restrict to specific units; null scans the full ledger. '
  'Called by the detect-duplicate-serials Edge Function before flagging.';

-- ─── Function 2: flag_duplicate_serial ────────────────────────────────────────
-- Atomically creates a fraud_flag for a duplicate-serial event and auto-locks
-- the unit using the existing lock_unit() function.
--
-- Idempotency contract:
--   If an active (open, under_review, escalated) fraud_flag with
--   source = 'duplicate_serial' already exists for this unit, no new flag is
--   created. The existing flag_id and its auto_lock_id are returned with
--   was_created = false.
--
-- Auto-lock contract:
--   If the unit's current status is lockable (available, reserved, sold, returned),
--   lock_unit() is called with lock_authority = 'system'. The resulting lock_record_id
--   is written back to fraud_flags.auto_lock_id and auto_locked is set to true.
--   If the unit is already fraud_locked or voided, no lock is attempted;
--   lock_record_id is returned as null and auto_locked remains false.
--
-- Transaction safety:
--   Both the flag INSERT and the lock_unit() call run in a single transaction.
--   lock_unit() acquires SELECT FOR UPDATE on the unit — within the same
--   transaction this is a no-op (the lock is already held), and lock_unit()
--   reads the pre-lock status correctly because no UPDATE has been issued yet.
--
-- Parameters:
--   p_unit_id          uuid  — the unit to flag (required)
--   p_description      text  — human-readable detection description (required)
--   p_related_order_id uuid  — the conflicting order, if known (optional)
--   p_signal_metadata  jsonb — raw detection data for investigator context (optional)
--   p_raised_by        uuid  — auth.users.id of the system/admin triggering this (required)
--
-- Returns:
--   fraud_flag_id   uuid     — the fraud_flags.id (new or existing)
--   lock_record_id  uuid     — the lock_records.id created, or null if no lock
--   was_created     boolean  — false when an active flag already existed (idempotent)

create or replace function public.flag_duplicate_serial(
  p_unit_id           uuid,
  p_description       text,
  p_related_order_id  uuid   default null,
  p_signal_metadata   jsonb  default null,
  p_raised_by         uuid   default null
)
returns table (
  fraud_flag_id   uuid,
  lock_record_id  uuid,
  was_created     boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit              record;
  v_existing_flag_id  uuid;
  v_existing_lock_id  uuid;
  v_flag_id           uuid;
  v_lock_record_id    uuid;
begin

  -- ── Validate required parameters ──────────────────────────────────────────
  if p_unit_id is null then
    raise exception '[GTG] flag_duplicate_serial: p_unit_id is required.';
  end if;
  if p_description is null or trim(p_description) = '' then
    raise exception '[GTG] flag_duplicate_serial: p_description is required.';
  end if;
  if p_raised_by is null then
    raise exception '[GTG] flag_duplicate_serial: p_raised_by is required.';
  end if;

  -- ── Row lock on the unit ──────────────────────────────────────────────────
  -- Acquire exclusive row lock before reading status. Prevents a concurrent
  -- flag_duplicate_serial call on the same unit from both proceeding past the
  -- idempotency check and creating two flags.
  select
    id,
    serial_number,
    sku,
    status
  into v_unit
  from public.serialized_units
  where id = p_unit_id
  for update;

  if not found then
    raise exception '[GTG] flag_duplicate_serial: unit not found (id=%).', p_unit_id;
  end if;

  -- ── Idempotency: check for existing active flag ───────────────────────────
  -- 'confirmed' and 'dismissed' flags are terminal — a new signal after
  -- dismissal can legitimately produce a new flag. Only open investigations
  -- block re-flagging.
  select id, auto_lock_id
  into v_existing_flag_id, v_existing_lock_id
  from public.fraud_flags
  where unit_id = p_unit_id
    and source   = 'duplicate_serial'
    and status  in ('open', 'under_review', 'escalated')
  limit 1;

  if v_existing_flag_id is not null then
    return query select v_existing_flag_id, v_existing_lock_id, false;
    return;
  end if;

  -- ── Create fraud_flag ─────────────────────────────────────────────────────
  -- Inserted with auto_locked = false, auto_lock_id = null; both updated
  -- below if a lock is successfully applied. This ordering ensures the flag
  -- exists before lock_unit() links back to it via p_fraud_flag_id.
  insert into public.fraud_flags (
    unit_id,
    serial_number,
    sku,
    source,
    severity,
    status,
    unit_status_at_flag,
    auto_locked,
    auto_lock_id,
    related_order_id,
    signal_metadata,
    description,
    raised_by
  ) values (
    p_unit_id,
    v_unit.serial_number,
    v_unit.sku,
    'duplicate_serial',
    'high',
    'open',
    v_unit.status,
    false,
    null,
    p_related_order_id,
    p_signal_metadata,
    p_description,
    p_raised_by
  )
  returning id into v_flag_id;

  -- ── Auto-lock (severity = 'high') ─────────────────────────────────────────
  -- Only lock if the unit is in a lockable state. fraud_locked and voided
  -- units are skipped — fraud_locked units are already controlled, voided
  -- units are terminal.
  if v_unit.status in ('available', 'reserved', 'sold', 'returned') then

    -- lock_unit() does its own SELECT FOR UPDATE on the same row. Within this
    -- transaction, that re-acquisition is a no-op — the lock is already held.
    -- lock_unit reads the pre-lock status correctly (no UPDATE has been issued yet).
    select lr.lock_record_id into v_lock_record_id
    from public.lock_unit(
      p_unit_id,
      p_raised_by,
      'Duplicate serial auto-lock: ' || p_description,
      'system',
      v_flag_id,
      null   -- licensor_reference_id: not applicable for system locks
    ) lr;

    -- Wire the lock reference back onto the flag.
    update public.fraud_flags
    set
      auto_locked  = true,
      auto_lock_id = v_lock_record_id
    where id = v_flag_id;

  end if;

  -- v_lock_record_id is null when the unit was not lockable (already fraud_locked
  -- or voided). Callers should inspect this to distinguish "locked now" from
  -- "flagged but not locked".
  return query select v_flag_id, v_lock_record_id, true;

end;
$$;

grant execute on function public.flag_duplicate_serial(uuid, text, uuid, jsonb, uuid)
  to service_role;

comment on function public.flag_duplicate_serial(uuid, text, uuid, jsonb, uuid) is
  'Atomically creates a duplicate_serial fraud_flag (severity=high) and auto-locks '
  'the unit under system authority. Idempotent: returns the existing flag if an active '
  'open/under_review/escalated duplicate_serial flag already exists for the unit. '
  'Skips the lock if the unit is already fraud_locked or voided. '
  'Called per-unit by the detect-duplicate-serials Edge Function.';
