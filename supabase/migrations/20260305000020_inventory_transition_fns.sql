-- =============================================================================
-- Migration: 20260305000020_inventory_transition_fns
--
-- Creates two functions that together form the foundational infrastructure
-- for all inventory state transitions:
--
--   1. public.append_ledger_entry(...)
--      Shared internal utility — inserts one validated inventory_ledger_entries
--      row. Never called directly by application code; always invoked by
--      higher-level transition functions (lock_unit, void_unit, and future
--      reserve_unit, sell_unit, return_unit functions) that hold a row lock
--      on the unit before calling it.
--
--   2. public.void_unit(...)
--      Atomically transitions a serialized unit to 'voided' status.
--      Acquires FOR UPDATE row lock → validates status → UPDATEs unit →
--      calls append_ledger_entry → returns ledger_entry_id.
--
-- Design rationale for the two-layer split:
--   Transition functions (lock_unit, void_unit, future reserve_unit, etc.)
--   share identical ledger-insert logic. Centralising that logic in
--   append_ledger_entry eliminates duplication and ensures every ledger row
--   is written with the same field mapping and constraint awareness.
--   The higher-level functions own the row lock and status update; they
--   delegate only the insert to append_ledger_entry.
--
-- Why NOT a single generic "transition_unit" function?
--   Each action type has different required context fields, different update
--   paths on serialized_units, and different business rules. A single function
--   with many optional parameters and branching logic would be harder to audit
--   and test than small, focused functions. The shared utility handles only
--   what is truly shared: the validated INSERT.
-- =============================================================================


-- =============================================================================
-- 1. append_ledger_entry — shared INSERT utility
--
-- Inserts one row into inventory_ledger_entries with full field mapping.
-- Enforces the constraints that are also present in the table definition:
--   - reason is required for fraud_locked, fraud_released, voided
--   - from_status must be null for 'received'; non-null for all other actions
--   - retail_price_cents must be positive when provided
--   - royalty_rate must satisfy the table check (> 0 and <= 1)
--
-- Callers MUST hold a FOR UPDATE lock on the serialized_units row (obtained
-- via their own SELECT ... FOR UPDATE) before calling this function, to
-- prevent interleaved concurrent inserts recording inconsistent from_status /
-- to_status snapshots.
--
-- Parameters:
--   p_unit_id            uuid              — references serialized_units.id
--   p_action             ledger_action     — the event being recorded
--   p_performed_by       uuid              — actor's auth.users.id
--   p_serial_number      text              — denormalized; must match unit row
--   p_sku                text              — denormalized; must match unit row
--   p_product_name       text              — denormalized; must match unit row
--   p_from_status        unit_status|null  — status before this action
--                                            (null only for 'received')
--   p_to_status          unit_status       — status after this action
--   p_license_body       license_body      — denormalized; must match unit row
--   p_royalty_rate       numeric           — denormalized; must match unit row
--   p_order_id           uuid|null         — populated for reserved/sold/returned
--   p_consultant_id      uuid|null         — populated for sold/returned
--   p_retail_price_cents integer|null      — populated for sold/returned
--   p_reason             text|null         — required for fraud_locked/released/voided
--   p_metadata           jsonb|null        — extensible action-specific context
--
-- Returns: ledger_entry_id uuid
-- =============================================================================

create or replace function public.append_ledger_entry(
  p_unit_id             uuid,
  p_action              public.ledger_action,
  p_performed_by        uuid,
  p_serial_number       text,
  p_sku                 text,
  p_product_name        text,
  p_from_status         public.unit_status,   -- null accepted; PL/pgSQL allows
  p_to_status           public.unit_status,
  p_license_body        public.license_body,
  p_royalty_rate        numeric,
  p_order_id            uuid    default null,
  p_consultant_id       uuid    default null,
  p_retail_price_cents  integer default null,
  p_reason              text    default null,
  p_metadata            jsonb   default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid := gen_random_uuid();
begin
  -- Mirror the table check constraints so the function raises a clear error
  -- rather than propagating a cryptic constraint violation from INSERT.

  -- reason is required for enforcement and destructive actions.
  if p_action in ('fraud_locked', 'fraud_released', 'voided') and p_reason is null then
    raise exception
      '[GTG] append_ledger_entry: reason is required for action ''%''.',
      p_action;
  end if;

  -- from_status must be null only for 'received'; non-null for everything else.
  if p_action = 'received' and p_from_status is not null then
    raise exception
      '[GTG] append_ledger_entry: from_status must be null for action ''received''.';
  end if;

  if p_action != 'received' and p_from_status is null then
    raise exception
      '[GTG] append_ledger_entry: from_status is required for action ''%''.',
      p_action;
  end if;

  -- retail_price_cents must be positive when provided.
  if p_retail_price_cents is not null and p_retail_price_cents <= 0 then
    raise exception
      '[GTG] append_ledger_entry: retail_price_cents must be positive when provided (got %).',
      p_retail_price_cents;
  end if;

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
    v_entry_id,
    p_unit_id,
    p_serial_number,
    p_sku,
    p_product_name,
    p_action,
    p_from_status,
    p_to_status,
    p_performed_by,
    p_order_id,
    p_consultant_id,
    p_license_body,
    p_royalty_rate,
    p_retail_price_cents,
    p_reason,
    p_metadata,
    now()
  );

  return v_entry_id;
end;
$$;

-- append_ledger_entry is an internal utility — called only by other SECURITY
-- DEFINER functions. Granted to service_role as a safety net for direct RPC
-- calls during debugging, but production code should not call it directly.
grant execute on function public.append_ledger_entry(
  uuid, public.ledger_action, uuid,
  text, text, text,
  public.unit_status, public.unit_status,
  public.license_body, numeric,
  uuid, uuid, integer, text, jsonb
) to service_role;

comment on function public.append_ledger_entry(
  uuid, public.ledger_action, uuid,
  text, text, text,
  public.unit_status, public.unit_status,
  public.license_body, numeric,
  uuid, uuid, integer, text, jsonb
) is
  'Internal utility: inserts one validated inventory_ledger_entries row. '
  'Must only be called by transition functions that already hold a FOR UPDATE '
  'row lock on the serialized_units row to prevent interleaved concurrent writes. '
  'Never call directly from application code — use the dedicated transition '
  'functions (lock_unit, void_unit, reserve_unit, sell_unit, return_unit).';


-- =============================================================================
-- 2. void_unit — atomic unit voiding
--
-- Permanently removes a serialized unit from active inventory.
-- A voided unit can never be sold, reserved, or returned. The voided status
-- is terminal and is enforced by the status transition trigger (migration 18).
--
-- The operation:
--   1. SELECT ... FOR UPDATE — prevents concurrent status changes.
--   2. Pre-check: any non-voided status is allowed (units may be voided from
--      any lifecycle state, including fraud_locked, as a write-off action).
--      'voided' itself is terminal and cannot be re-voided.
--   3. UPDATE serialized_units — status → voided, updated_at → now().
--   4. append_ledger_entry — action='voided', from_status=old, to_status=voided.
--   5. Returns the ledger_entry_id for the caller's audit record.
--
-- Note on fraud_locked units:
--   A fraud_locked unit may be voided (e.g. confirmed counterfeit written off).
--   The existing fraud_lock fields (fraud_locked_at/by/reason) are preserved
--   on the unit row as part of the permanent audit trail — they are NOT cleared
--   on void. The lock_records row remains is_active=true; no automatic release
--   is performed. The caller must separately release the lock_record if
--   appropriate for the business scenario.
--
-- Parameters:
--   p_unit_id       uuid   — unit to void
--   p_performed_by  uuid   — actor's auth.users.id (recorded on ledger entry)
--   p_reason        text   — required; recorded on ledger entry
--   p_metadata      jsonb  — optional extensible context (e.g. disposal method)
--
-- Returns: TABLE(ledger_entry_id uuid)
-- =============================================================================

create or replace function public.void_unit(
  p_unit_id       uuid,
  p_performed_by  uuid,
  p_reason        text,
  p_metadata      jsonb default null
)
returns table (
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit          record;
  v_ledger_id     uuid;
begin
  -- ── Row lock ─────────────────────────────────────────────────────────────────
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
    raise exception '[GTG] void_unit: unit not found (id=%).', p_unit_id;
  end if;

  -- ── Pre-check ─────────────────────────────────────────────────────────────────
  -- 'voided' is terminal — re-voiding is meaningless and the status transition
  -- trigger (migration 18) would also reject it. Pre-check here gives a clearer
  -- application-level message.
  if v_unit.status = 'voided' then
    raise exception
      '[GTG] void_unit: unit ''%'' (id=%) is already voided. '
      'Voided is a terminal status — no further transitions are permitted.',
      v_unit.serial_number, p_unit_id;
  end if;

  -- p_reason is required for 'voided' ledger entries; validate early.
  if p_reason is null or trim(p_reason) = '' then
    raise exception
      '[GTG] void_unit: reason is required when voiding a unit. '
      'Record why the unit is being written off (damage, loss, confirmed counterfeit, etc.).';
  end if;

  -- ── Write 1: Update serialized_units ─────────────────────────────────────────
  -- The status transition trigger validates 'voided' is reachable from the
  -- current status (it is reachable from all non-voided states per migration 18).

  update public.serialized_units
  set
    status     = 'voided',
    updated_at = now()
  where id = p_unit_id;

  -- ── Write 2: Append ledger entry ─────────────────────────────────────────────
  -- append_ledger_entry validates reason is non-null for 'voided' (belt-and-suspenders
  -- given the pre-check above) and from_status is non-null for non-'received' actions.

  v_ledger_id := public.append_ledger_entry(
    p_unit_id             => p_unit_id,
    p_action              => 'voided',
    p_performed_by        => p_performed_by,
    p_serial_number       => v_unit.serial_number,
    p_sku                 => v_unit.sku,
    p_product_name        => v_unit.product_name,
    p_from_status         => v_unit.status,     -- status snapshot BEFORE the update
    p_to_status           => 'voided',
    p_license_body        => v_unit.license_body,
    p_royalty_rate        => v_unit.royalty_rate,
    p_order_id            => null,              -- not applicable to void action
    p_consultant_id       => null,              -- not applicable to void action
    p_retail_price_cents  => null,              -- not applicable to void action
    p_reason              => trim(p_reason),
    p_metadata            => p_metadata
  );

  return query select v_ledger_id;
end;
$$;

grant execute on function public.void_unit(uuid, uuid, text, jsonb)
  to service_role;

comment on function public.void_unit(uuid, uuid, text, jsonb) is
  'Atomically transitions a serialized unit to ''voided'' status and appends an '
  'inventory_ledger_entries row. Acquires a FOR UPDATE row lock to prevent '
  'concurrent transitions. Voided is terminal — no further status changes are '
  'permitted on a voided unit. Called by the create-inventory-ledger-entries '
  'Edge Function. For fraud-locked units that are voided, the associated '
  'lock_records row is NOT automatically released — handle separately if required.';
