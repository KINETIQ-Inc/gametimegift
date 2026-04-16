-- =============================================================================
-- Migration: 20260305000027_create_fraud_flag_fn
--
-- Creates:
--   function public.create_fraud_flag   general-purpose fraud signal insert
--
-- ─── Background ──────────────────────────────────────────────────────────────
--
-- The fraud_flags table receives signals from multiple sources:
--
--   hologram_scan_fail    Hologram verification returned invalid
--   duplicate_serial      Same serial submitted on multiple orders (automated)
--   duplicate_hologram    Hologram ID appears on more than one unit record
--   consultant_report     Consultant self-reported a suspected counterfeit
--   customer_report       Customer reported an authenticity concern
--   licensor_report       CLC or Army flagged a unit in their audit
--   admin_manual          Admin flagged manually during investigation
--   payment_chargeback    Chargeback received; possible stolen card / resale fraud
--   velocity_anomaly      Unusual sale rate on a serial or consultant account
--
-- Automated detection paths (duplicate_serial via detect-duplicate-serials)
-- have their own specialized functions that bundle detection + flagging. This
-- function is the intake point for all other sources — signals that arrive
-- from external systems, manual admin review, or cannot be auto-detected.
--
-- ─── Source-specific required fields ─────────────────────────────────────────
--
--   source = 'licensor_report'    reporting_licensor required ('CLC' or 'ARMY')
--   source = 'payment_chargeback' related_order_id required
--   all other sources             no additional required fields
--
-- ─── Auto-lock policy ────────────────────────────────────────────────────────
--
-- severity 'high' or 'critical' → auto-lock unit under 'system' authority.
-- Auto-lock is skipped when the unit is already 'fraud_locked' or 'voided'.
-- In both cases, lock_record_id is returned as null.
--
-- The lock and the flag are written in a single transaction. A failure after
-- the flag INSERT but before the lock cannot occur — PL/pgSQL rolls back the
-- entire block on any unhandled exception.
--
-- ─── Relationship to flag_duplicate_serial ────────────────────────────────────
--
-- flag_duplicate_serial() is a specialized function for the duplicate_serial
-- signal that adds idempotency logic specific to automated detection runs.
-- create_fraud_flag() does not enforce idempotency — callers are responsible
-- for checking whether an active flag already exists for the same unit and
-- source before creating a new one. Multiple flags per unit per source are
-- permitted (e.g., two independent consultant reports on the same unit).
-- =============================================================================

create or replace function public.create_fraud_flag(
  p_unit_id                uuid,
  p_source                 public.fraud_signal_source,
  p_severity               public.fraud_flag_severity,
  p_description            text,
  p_raised_by              uuid,
  p_related_order_id       uuid    default null,
  p_related_consultant_id  uuid    default null,
  p_reporting_licensor     text    default null,
  p_signal_metadata        jsonb   default null
)
returns table (
  fraud_flag_id   uuid,
  lock_record_id  uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit            record;
  v_flag_id         uuid;
  v_lock_record_id  uuid;
begin

  -- ── Validate required parameters ──────────────────────────────────────────
  if p_unit_id is null then
    raise exception '[GTG] create_fraud_flag: p_unit_id is required.';
  end if;
  if p_source is null then
    raise exception '[GTG] create_fraud_flag: p_source is required.';
  end if;
  if p_severity is null then
    raise exception '[GTG] create_fraud_flag: p_severity is required.';
  end if;
  if p_description is null or trim(p_description) = '' then
    raise exception '[GTG] create_fraud_flag: p_description is required.';
  end if;
  if p_raised_by is null then
    raise exception '[GTG] create_fraud_flag: p_raised_by is required.';
  end if;

  -- ── Source-specific field validation ─────────────────────────────────────
  -- licensor_report: the reporting licensor is a required audit field.
  if p_source = 'licensor_report' then
    if p_reporting_licensor is null then
      raise exception
        '[GTG] create_fraud_flag: reporting_licensor is required for licensor_report signals. '
        'Provide ''CLC'' or ''ARMY''.';
    end if;
    -- The fraud_flags_reporting_licensor_valid constraint enforces this at the DB level,
    -- but raising here gives a clearer message specific to licensor_report context.
    if p_reporting_licensor not in ('CLC', 'ARMY') then
      raise exception
        '[GTG] create_fraud_flag: reporting_licensor must be ''CLC'' or ''ARMY'', got ''%''. '
        'Only CLC and Army are licensed authorities for GTG products.',
        p_reporting_licensor;
    end if;
  end if;

  -- payment_chargeback: the order is the core context; flagging without it
  -- loses the link to the transaction under dispute.
  if p_source = 'payment_chargeback' and p_related_order_id is null then
    raise exception
      '[GTG] create_fraud_flag: related_order_id is required for payment_chargeback signals. '
      'Provide the order UUID associated with the chargeback event.';
  end if;

  -- ── Fetch and row-lock the unit ───────────────────────────────────────────
  -- FOR UPDATE prevents a concurrent lock_unit() call from changing unit
  -- status between our status check and the lock_unit() call below.
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
    raise exception '[GTG] create_fraud_flag: unit not found (id=%).', p_unit_id;
  end if;

  -- ── Insert fraud_flag ─────────────────────────────────────────────────────
  -- auto_locked and auto_lock_id are set to their default (false, null) here
  -- and updated below if an auto-lock is successfully applied. This ordering
  -- ensures the flag row exists before lock_unit() links back to it via
  -- p_fraud_flag_id.
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
    related_consultant_id,
    reporting_licensor,
    signal_metadata,
    description,
    raised_by
  ) values (
    p_unit_id,
    v_unit.serial_number,
    v_unit.sku,
    p_source,
    p_severity,
    'open',
    v_unit.status,
    false,
    null,
    p_related_order_id,
    p_related_consultant_id,
    p_reporting_licensor,
    p_signal_metadata,
    p_description,
    p_raised_by
  )
  returning id into v_flag_id;

  -- ── Auto-lock (severity high or critical) ─────────────────────────────────
  -- Only applied when the unit is in a lockable status. fraud_locked units
  -- are already controlled; voided units are terminal. In both cases the
  -- flag is created but lock_record_id is returned as null.
  if p_severity in ('high', 'critical')
     and v_unit.status in ('available', 'reserved', 'sold', 'returned')
  then
    -- lock_unit() issues its own SELECT FOR UPDATE on the same row. Within
    -- this transaction that re-acquisition is a no-op; it reads the original
    -- pre-lock status correctly because the UPDATE has not been issued yet.
    select lr.lock_record_id into v_lock_record_id
    from public.lock_unit(
      p_unit_id,
      p_raised_by,
      'Fraud flag auto-lock (source=' || p_source::text
        || ', severity=' || p_severity::text || '): ' || p_description,
      'system',
      v_flag_id,
      null   -- licensor_reference_id: not applicable for system auto-locks
    ) lr;

    -- Wire the lock reference back onto the flag atomically within this
    -- same transaction.
    update public.fraud_flags
    set
      auto_locked  = true,
      auto_lock_id = v_lock_record_id
    where id = v_flag_id;

  end if;

  -- v_lock_record_id is null when auto-lock was not applied (low/medium
  -- severity, or unit was already fraud_locked/voided).
  return query select v_flag_id, v_lock_record_id;

end;
$$;

grant execute on function public.create_fraud_flag(
  uuid, public.fraud_signal_source, public.fraud_flag_severity,
  text, uuid, uuid, uuid, text, jsonb
) to service_role;

comment on function public.create_fraud_flag(
  uuid, public.fraud_signal_source, public.fraud_flag_severity,
  text, uuid, uuid, uuid, text, jsonb
) is
  'General-purpose fraud signal intake. Inserts a fraud_flags row for any '
  'fraud_signal_source and auto-locks the unit (system authority) when severity '
  'is high or critical and the unit is in a lockable status. '
  'Source-specific required fields: licensor_report requires reporting_licensor; '
  'payment_chargeback requires related_order_id. '
  'Does not enforce idempotency — callers check for existing active flags. '
  'Specialized sources (duplicate_serial) have dedicated detection functions.';
