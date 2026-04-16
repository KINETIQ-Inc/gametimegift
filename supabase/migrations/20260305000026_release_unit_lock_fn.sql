-- =============================================================================
-- Migration: 20260305000026_release_unit_lock_fn
--
-- Creates:
--   function public.release_unit_lock   authority-validated atomic lock release
--
-- ─── Background ──────────────────────────────────────────────────────────────
--
-- Releasing a unit lock is the inverse of lock_unit(). It must:
--   1. Validate that the release authority is permitted to lift the lock.
--   2. Deactivate the lock_records row (is_active → false).
--   3. Restore serialized_units.status to the pre-lock value.
--   4. Clear the fraud_lock fields on serialized_units.
--   5. Append a 'fraud_released' inventory_ledger_entries row.
--
-- All five steps occur in a single transaction. A partial release — lock
-- deactivated but unit status not restored, or no ledger entry written — would
-- leave the system in an unauditable state that compliance review cannot
-- reconcile. Wrapping everything in a SECURITY DEFINER function guarantees
-- atomicity regardless of network or application failure.
--
-- ─── Authority validation rules ──────────────────────────────────────────────
--
-- Who may release a lock is determined by who applied it:
--
--   lock_authority = 'system'   →  release_authority must be 'gtg_admin'
--   lock_authority = 'gtg_admin' → release_authority must be 'gtg_admin'
--   lock_authority = 'clc'      →  release_authority must be 'clc' or 'gtg_admin'
--   lock_authority = 'army'     →  release_authority must be 'army' or 'gtg_admin'
--
-- Additionally, release_reference_id is required when release_authority is
-- 'clc' or 'army' — the licensor must provide a document reference authorising
-- the release, which is recorded for audit and dispute resolution.
--
-- GTG admin override:
--   A gtg_admin may release a licensor (clc/army) lock under their own authority
--   without a release_reference_id. This models emergency internal releases
--   where the licensor approval document has not yet been received. The action is
--   fully logged in the lock_records row and the ledger entry for compliance review.
--
-- ─── Status restoration ──────────────────────────────────────────────────────
--
-- lock_records.status_before_lock stores the unit's status at the moment the
-- lock was applied (as text, to avoid enum coupling across scopes). On release,
-- this value is cast back to public.unit_status and written to
-- serialized_units.status. The cast is safe: the value was a valid enum member
-- at lock time and the enum is append-only.
--
-- ─── Fraud flag lifecycle ─────────────────────────────────────────────────────
--
-- Releasing a lock does NOT automatically close the fraud_flag. The
-- investigation workflow (open → under_review → confirmed/dismissed) is
-- separate from the operational consequence (lock on/off). An investigator
-- may release a unit while the investigation continues (e.g. to allow a resale
-- while gathering evidence), or may confirm/dismiss the flag independently.
-- =============================================================================

create or replace function public.release_unit_lock(
  p_lock_record_id       uuid,
  p_released_by          uuid,
  p_release_reason       text,
  p_release_authority    public.lock_authority,
  p_release_reference_id text  default null
)
returns table (
  unit_id          uuid,
  restored_status  public.unit_status,
  ledger_entry_id  uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock       record;
  v_unit       record;
  v_unit_id    uuid;
  v_restored   public.unit_status;
  v_ledger_id  uuid;
  v_now        timestamptz := now();
begin

  -- ── Validate required parameters ──────────────────────────────────────────
  if p_lock_record_id is null then
    raise exception '[GTG] release_unit_lock: p_lock_record_id is required.';
  end if;
  if p_released_by is null then
    raise exception '[GTG] release_unit_lock: p_released_by is required.';
  end if;
  if p_release_reason is null or trim(p_release_reason) = '' then
    raise exception '[GTG] release_unit_lock: p_release_reason is required.';
  end if;
  if p_release_authority is null then
    raise exception '[GTG] release_unit_lock: p_release_authority is required.';
  end if;

  -- ── Fetch and row-lock the lock_records row ───────────────────────────────
  -- FOR UPDATE prevents two concurrent release calls from both reading
  -- is_active = true and both proceeding to release the same lock.
  select
    id,
    scope,
    target_id,
    lock_authority,
    status_before_lock,
    is_active
  into v_lock
  from public.lock_records
  where id = p_lock_record_id
  for update;

  if not found then
    raise exception '[GTG] release_unit_lock: lock_record not found (id=%).', p_lock_record_id;
  end if;

  -- ── Scope guard ───────────────────────────────────────────────────────────
  -- This function handles unit-scope locks only. Consultant and order locks
  -- involve different status enums and different tables.
  if v_lock.scope != 'unit' then
    raise exception
      '[GTG] release_unit_lock: lock ''%'' has scope ''%''. '
      'Only unit-scope locks are handled by this function. '
      'Consultant and order lock releases use separate functions.',
      p_lock_record_id, v_lock.scope;
  end if;

  -- ── Already released guard ────────────────────────────────────────────────
  if v_lock.is_active = false then
    raise exception
      '[GTG] release_unit_lock: lock ''%'' is already released (is_active = false). '
      'Each lock may only be released once.',
      p_lock_record_id;
  end if;

  -- ── Authority validation ──────────────────────────────────────────────────
  -- Enforce which authorities may release a lock applied by a given authority.
  if v_lock.lock_authority in ('system', 'gtg_admin') then
    if p_release_authority != 'gtg_admin' then
      raise exception
        '[GTG] release_unit_lock: lock was applied under ''%'' authority. '
        'Only ''gtg_admin'' may release this lock. '
        'Provided release_authority: ''%''.',
        v_lock.lock_authority, p_release_authority;
    end if;

  elsif v_lock.lock_authority = 'clc' then
    if p_release_authority not in ('clc', 'gtg_admin') then
      raise exception
        '[GTG] release_unit_lock: lock was applied under CLC authority. '
        'Release requires release_authority = ''clc'' (with licensor reference) '
        'or ''gtg_admin'' (GTG internal override). '
        'Provided release_authority: ''%''.',
        p_release_authority;
    end if;

  elsif v_lock.lock_authority = 'army' then
    if p_release_authority not in ('army', 'gtg_admin') then
      raise exception
        '[GTG] release_unit_lock: lock was applied under Army authority. '
        'Release requires release_authority = ''army'' (with licensor reference) '
        'or ''gtg_admin'' (GTG internal override). '
        'Provided release_authority: ''%''.',
        p_release_authority;
    end if;
  end if;

  -- ── Release reference required for licensor releases ─────────────────────
  -- When the releasing authority is a licensor, their approval document
  -- reference must be recorded for audit and dispute resolution.
  if p_release_authority in ('clc', 'army') and p_release_reference_id is null then
    raise exception
      '[GTG] release_unit_lock: release_reference_id is required when '
      'release_authority is ''%''. '
      'Provide the licensor approval document or correspondence reference.',
      p_release_authority;
  end if;

  -- ── Resolve unit_id ───────────────────────────────────────────────────────
  -- target_id is stored as text (scope-agnostic). For unit scope it is always
  -- a valid UUID.
  v_unit_id := v_lock.target_id::uuid;

  -- ── Fetch and row-lock the unit ───────────────────────────────────────────
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
  where id = v_unit_id
  for update;

  if not found then
    raise exception '[GTG] release_unit_lock: unit ''%'' not found.', v_unit_id;
  end if;

  -- ── Status consistency guard ──────────────────────────────────────────────
  -- The unit must be fraud_locked. If it is not, the lock_records row and
  -- the unit's actual status are out of sync — this indicates a data integrity
  -- violation that must be investigated before any automated release.
  if v_unit.status != 'fraud_locked' then
    raise exception
      '[GTG] release_unit_lock: unit ''%'' (serial=''%'') has status ''%'' '
      'but lock ''%'' is still active. '
      'Unit status and lock record are out of sync — investigate before releasing.',
      v_unit_id, v_unit.serial_number, v_unit.status, p_lock_record_id;
  end if;

  -- ── Determine the status to restore ──────────────────────────────────────
  -- Cast the stored text value back to the enum. Safe: the value was a valid
  -- public.unit_status member when the lock was applied, and the enum is
  -- append-only (no values are ever removed).
  v_restored := v_lock.status_before_lock::public.unit_status;

  -- ── Write 1: Deactivate the lock record ───────────────────────────────────
  -- The lock_records_release_consistent constraint requires that all five
  -- release fields (is_active=false, release_reason, release_authority,
  -- released_by, released_at) are set together — atomicity within the UPDATE.
  update public.lock_records
  set
    is_active              = false,
    release_reason         = p_release_reason,
    release_authority      = p_release_authority,
    release_reference_id   = p_release_reference_id,
    released_by            = p_released_by,
    released_at            = v_now,
    updated_at             = v_now
  where id = p_lock_record_id;

  -- ── Write 2: Restore unit status and clear fraud lock fields ─────────────
  -- The serialized_units_fraud_lock_consistent constraint requires that all
  -- three fraud lock fields (fraud_locked_at, fraud_locked_by, fraud_lock_reason)
  -- are cleared together. Setting all to null satisfies the constraint's
  -- "all absent" branch.
  update public.serialized_units
  set
    status            = v_restored,
    fraud_locked_at   = null,
    fraud_locked_by   = null,
    fraud_lock_reason = null,
    updated_at        = v_now
  where id = v_unit_id;

  -- ── Write 3: Append inventory_ledger_entries (fraud_released) ────────────
  -- reason is required for action = 'fraud_released' (inventory_ledger_entries_
  -- reason_required constraint). from_status = 'fraud_locked' (the unit's state
  -- before this action). to_status = the restored pre-lock status.
  -- metadata captures the full lock authority chain for compliance traceability.
  v_ledger_id := gen_random_uuid();

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
    v_unit_id,
    v_unit.serial_number,
    v_unit.sku,
    v_unit.product_name,
    'fraud_released',
    'fraud_locked',       -- from: unit was fraud_locked before this action
    v_restored,           -- to: the pre-lock status restored by this release
    p_released_by,
    null,                 -- order_id: not applicable to fraud release action
    null,                 -- consultant_id: not applicable to fraud release action
    v_unit.license_body,
    v_unit.royalty_rate,
    null,                 -- retail_price_cents: not applicable to fraud release action
    p_release_reason,     -- reason: required for fraud_released
    jsonb_build_object(
      'lock_record_id',        p_lock_record_id,
      'lock_authority',        v_lock.lock_authority,
      'release_authority',     p_release_authority,
      'release_reference_id',  p_release_reference_id
    ),
    v_now
  );

  return query select v_unit_id, v_restored, v_ledger_id;

end;
$$;

grant execute on function public.release_unit_lock(uuid, uuid, text, public.lock_authority, text)
  to service_role;

comment on function public.release_unit_lock(uuid, uuid, text, public.lock_authority, text) is
  'Atomically releases a unit fraud lock with authority validation. '
  'Validates release_authority against lock_authority, deactivates the lock_records row, '
  'restores serialized_units.status to the pre-lock value, clears fraud lock fields, '
  'and appends a fraud_released inventory_ledger_entries row — all in one transaction. '
  'Does NOT close the fraud_flag: investigation lifecycle is managed separately. '
  'Called by the release-unit-lock Edge Function.';
