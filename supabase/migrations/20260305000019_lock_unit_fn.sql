-- =============================================================================
-- Migration: 20260305000019_lock_unit_fn
--
-- Creates a SECURITY DEFINER function that applies a fraud lock to a single
-- serialized unit atomically.
--
-- Why a database function rather than sequential Edge Function writes:
--   Locking is a compliance-critical write that must touch three tables in one
--   transaction: serialized_units (status change), lock_records (enforcement
--   record), and inventory_ledger_entries (audit trail). A partial write — e.g.
--   status updated but no lock_record created — leaves the system in an
--   unauditable state. Wrapping all three writes in a single PL/pgSQL function
--   guarantees that the transaction is all-or-nothing regardless of network
--   interruption or application error.
--
-- Concurrency:
--   The function acquires a FOR UPDATE row lock on the serialized_units row at
--   the start of the transaction. This prevents two concurrent calls from both
--   reading status = 'available' and both proceeding to update; the second call
--   blocks until the first commits, then reads the already-locked status and
--   fails its pre-check.
--
-- Caller:
--   The lock-units Edge Function calls this via admin.rpc('lock_unit', {...}).
--   The function is granted to service_role; the Edge Function's admin client
--   (service role key) satisfies this grant.
--
-- Function: public.lock_unit
--   Parameters:
--     p_unit_id               uuid              — unit to lock (required)
--     p_performed_by          uuid              — auth.users.id of the actor (required)
--     p_lock_reason           text              — human-readable reason (required)
--     p_lock_authority        lock_authority    — who holds authority (required)
--     p_fraud_flag_id         uuid   default null — link to existing FraudFlag (optional)
--     p_licensor_reference_id text   default null — licensor doc ref; required for
--                                                    clc/army authority (DB constraint enforces)
--
--   Returns: TABLE(lock_record_id uuid, ledger_entry_id uuid)
--     lock_record_id  — the newly created lock_records.id
--     ledger_entry_id — the newly created inventory_ledger_entries.id
--
--   Raises:
--     [GTG] lock_unit: unit not found         — p_unit_id does not exist
--     [GTG] lock_unit: invalid status          — unit cannot be fraud-locked from its current state
--     Propagated constraint violations         — DB-level check constraint failures
--       (e.g. licensor_reference_id missing for clc/army authority)
-- =============================================================================

create or replace function public.lock_unit(
  p_unit_id               uuid,
  p_performed_by          uuid,
  p_lock_reason           text,
  p_lock_authority        public.lock_authority,
  p_fraud_flag_id         uuid  default null,
  p_licensor_reference_id text  default null
)
returns table (
  lock_record_id  uuid,
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit            record;
  v_lock_record_id  uuid        := gen_random_uuid();
  v_ledger_id       uuid        := gen_random_uuid();
  v_now             timestamptz := now();
begin
  -- ── Row lock ─────────────────────────────────────────────────────────────────
  -- Acquire a row-level exclusive lock before reading status.
  -- Prevents TOCTOU: two concurrent calls cannot both read 'available' and
  -- both proceed to update. The second waits, then reads 'fraud_locked'.

  select
    id,
    serial_number,
    sku,
    product_name,
    status,
    license_body,
    royalty_rate
  into v_unit
  from public.serialized_units
  where id = p_unit_id
  for update;

  if not found then
    raise exception '[GTG] lock_unit: unit not found (id=%).', p_unit_id;
  end if;

  -- ── Pre-check status ─────────────────────────────────────────────────────────
  -- The status transition trigger (enforce_unit_status_transition, migration 18)
  -- also enforces this, but raises a generic transition error. This pre-check
  -- provides a more actionable message specific to the lock operation.
  --
  -- Lockable from: available, reserved, sold, returned
  -- Not lockable:  fraud_locked (already locked), voided (terminal)

  if v_unit.status not in ('available', 'reserved', 'sold', 'returned') then
    raise exception
      '[GTG] lock_unit: unit ''%'' (id=%) has status ''%'' and cannot be fraud-locked. '
      'Available, reserved, sold, and returned units are lockable. '
      'fraud_locked units are already locked; voided units are terminal.',
      v_unit.serial_number, p_unit_id, v_unit.status;
  end if;

  -- ── Write 1: Update serialized_units ─────────────────────────────────────────
  -- Transition status to 'fraud_locked' and populate the atomic fraud lock set.
  -- The constraint serialized_units_fraud_lock_consistent ensures all three
  -- fraud lock fields (fraud_locked_at, fraud_locked_by, fraud_lock_reason)
  -- are always set or cleared together.

  update public.serialized_units
  set
    status            = 'fraud_locked',
    fraud_locked_at   = v_now,
    fraud_locked_by   = p_performed_by,
    fraud_lock_reason = p_lock_reason,
    updated_at        = v_now
  where id = p_unit_id;

  -- ── Write 2: Insert lock_records ─────────────────────────────────────────────
  -- The check constraint lock_records_licensor_reference_required enforces that
  -- p_licensor_reference_id is non-null when p_lock_authority is 'clc' or 'army'.
  -- The check constraint lock_records_release_consistent enforces that all
  -- release fields are null for is_active = true (satisfied: all default null).

  insert into public.lock_records (
    id,
    fraud_flag_id,
    scope,
    target_id,
    target_label,
    lock_authority,
    status_before_lock,
    is_active,
    lock_reason,
    licensor_reference_id,
    locked_by,
    locked_at,
    created_at,
    updated_at
  ) values (
    v_lock_record_id,
    p_fraud_flag_id,
    'unit',
    p_unit_id::text,
    v_unit.serial_number,
    p_lock_authority,
    v_unit.status::text,      -- snapshot of status BEFORE the update above
    true,
    p_lock_reason,
    p_licensor_reference_id,
    p_performed_by,
    v_now,
    v_now,
    v_now
  );

  -- ── Write 3: Append inventory_ledger_entries ──────────────────────────────────
  -- The check constraint inventory_ledger_entries_reason_required enforces that
  -- reason is non-null for action = 'fraud_locked' (satisfied: p_lock_reason).
  -- The check constraint inventory_ledger_entries_from_status_consistent enforces
  -- that from_status is non-null for non-'received' actions (satisfied: v_unit.status).

  insert into public.inventory_ledger_entries (
    id,
    unit_id,
    serial_number,
    sku,
    product_name,
    action,
    from_status,
    to_status,
    performed_by,
    order_id,
    consultant_id,
    license_body,
    royalty_rate,
    retail_price_cents,
    reason,
    metadata,
    occurred_at
  ) values (
    v_ledger_id,
    p_unit_id,
    v_unit.serial_number,
    v_unit.sku,
    v_unit.product_name,
    'fraud_locked',
    v_unit.status,        -- from: pre-lock status (public.unit_status enum value)
    'fraud_locked',       -- to: fraud_locked
    p_performed_by,
    null,                 -- order_id: not applicable to fraud lock action
    null,                 -- consultant_id: not applicable to fraud lock action
    v_unit.license_body,
    v_unit.royalty_rate,
    null,                 -- retail_price_cents: not applicable to fraud lock action
    p_lock_reason,        -- reason: required for fraud_locked; set to lock reason
    null,                 -- metadata
    v_now
  );

  -- ── Return ────────────────────────────────────────────────────────────────────
  return query select v_lock_record_id, v_ledger_id;
end;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
-- Grant to service_role so the lock-units Edge Function's admin client
-- (Supabase service role key) can invoke this function via .rpc().
-- The function is SECURITY DEFINER, so it always runs as the function owner
-- (postgres) regardless of the calling role — RLS on all three tables is
-- effectively bypassed by the function itself, not by the caller.

grant execute on function public.lock_unit(
  uuid, uuid, text, public.lock_authority, uuid, text
) to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.lock_unit(
  uuid, uuid, text, public.lock_authority, uuid, text
) is
  'Atomically fraud-locks a serialized unit. Updates serialized_units.status to '
  '''fraud_locked'', creates a lock_records row, and appends an inventory_ledger_entries '
  'row — all in a single transaction. Acquires a row-level FOR UPDATE lock on the unit '
  'before reading status to prevent concurrent double-locks. '
  'Called by the lock-units Edge Function. Do not call from application code directly.';
