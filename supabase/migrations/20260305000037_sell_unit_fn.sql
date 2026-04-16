-- =============================================================================
-- Migration: 20260305000037_sell_unit_fn
--
-- Creates:
--   function public.sell_unit   atomic unit sale transition (reserved → sold)
--
-- Purpose:
--   Transitions a reserved serialized unit to 'sold' status and links it to
--   the confirmed order. Called by the stripe-webhook Edge Function immediately
--   after the order and order_line records have been created, completing the
--   inventory state machine for a successful Stripe payment.
--
-- ─── Operation ────────────────────────────────────────────────────────────────
--
--   1. SELECT ... FOR UPDATE — acquires row lock, prevents concurrent transitions.
--   2. Pre-check: unit must be in 'reserved' status. Raises if not — this
--      catches double-delivery of the same Stripe webhook event (the idempotency
--      guard in the Edge Function should prevent this, but the DB function
--      provides a second line of defence).
--   3. UPDATE serialized_units — status → 'sold', order_id → p_order_id.
--   4. append_ledger_entry — action='sold', captures full sale context:
--      order_id, consultant_id, and retail_price_cents.
--   5. Returns ledger_entry_id for caller audit records.
--
-- ─── Parameters ───────────────────────────────────────────────────────────────
--
--   p_unit_id            uuid    — unit to sell (must be 'reserved')
--   p_order_id           uuid    — confirmed order this unit belongs to
--   p_performed_by       uuid    — auth.users.id of actor (service account for webhook)
--   p_consultant_id      uuid    — consultant_profiles.id (null for direct sales)
--   p_retail_price_cents integer — sale price in cents captured from Stripe session
--
-- ─── Returns ──────────────────────────────────────────────────────────────────
--
--   TABLE(ledger_entry_id uuid)
--
-- ─── Errors ───────────────────────────────────────────────────────────────────
--
--   [GTG] sell_unit: unit not found     — unit_id does not exist
--   [GTG] sell_unit: wrong status       — unit is not in 'reserved' status
--
-- Caller:
--   stripe-webhook Edge Function via admin.rpc('sell_unit', {...}).
-- =============================================================================

create or replace function public.sell_unit(
  p_unit_id            uuid,
  p_order_id           uuid,
  p_performed_by       uuid,
  p_consultant_id      uuid    default null,
  p_retail_price_cents integer default null
)
returns table (
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit       record;
  v_ledger_id  uuid;
begin

  -- ── Row lock ──────────────────────────────────────────────────────────────────
  -- Prevents a concurrent expiry job or duplicate webhook from changing status
  -- between our pre-check read and the subsequent UPDATE.

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
    raise exception '[GTG] sell_unit: unit not found (id=%).', p_unit_id;
  end if;

  -- ── Pre-check ─────────────────────────────────────────────────────────────────
  -- Only a reserved unit may be sold. Any other status signals a workflow anomaly:
  -- duplicate webhook delivery, stale unit_id, or a reservation expiry race.
  -- The Edge Function idempotency check (payment_events.stripe_event_id) guards
  -- the first line of defence; this pre-check is the second.

  if v_unit.status != 'reserved' then
    raise exception
      '[GTG] sell_unit: unit ''%'' (id=%) must be in ''reserved'' status to sell. '
      'Current status: ''%''. This may indicate a duplicate webhook delivery or '
      'a reservation expiry race condition.',
      v_unit.serial_number, p_unit_id, v_unit.status;
  end if;

  -- ── Write 1: Update serialized_units ─────────────────────────────────────────
  -- The status transition trigger (migration 18) validates that
  -- reserved → sold is a permitted transition.
  -- order_id is set here — it was intentionally null during reservation
  -- (no order existed yet when the Stripe session was created).

  update public.serialized_units
  set
    status     = 'sold',
    order_id   = p_order_id,
    updated_at = now()
  where id = p_unit_id;

  -- ── Write 2: Append ledger entry ─────────────────────────────────────────────
  -- Delegates the validated INSERT to append_ledger_entry (migration 20).
  -- Captures the full sale context: order, consultant, and sale price.
  -- retail_price_cents and order_id are populated for 'sold' action entries
  -- per the append_ledger_entry parameter documentation.

  v_ledger_id := public.append_ledger_entry(
    p_unit_id            => p_unit_id,
    p_action             => 'sold',
    p_performed_by       => p_performed_by,
    p_serial_number      => v_unit.serial_number,
    p_sku                => v_unit.sku,
    p_product_name       => v_unit.product_name,
    p_from_status        => 'reserved',
    p_to_status          => 'sold',
    p_license_body       => v_unit.license_body,
    p_royalty_rate       => v_unit.royalty_rate,
    p_order_id           => p_order_id,
    p_consultant_id      => p_consultant_id,
    p_retail_price_cents => p_retail_price_cents
  );

  return query select v_ledger_id;

end;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.sell_unit(uuid, uuid, uuid, uuid, integer)
  to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.sell_unit(uuid, uuid, uuid, uuid, integer) is
  'Atomically transitions a serialized unit from ''reserved'' to ''sold'' and '
  'links it to the confirmed order by setting order_id on serialized_units. '
  'Appends a ''sold'' inventory_ledger_entries row via append_ledger_entry, '
  'capturing order_id, consultant_id, and retail_price_cents at sale time. '
  'Raises [GTG] sell_unit: unit not found if the unit_id is invalid. '
  'Raises [GTG] sell_unit: wrong status if the unit is not in ''reserved'' status '
  '(second-line defence against duplicate Stripe webhook delivery). '
  'Called exclusively by the stripe-webhook Edge Function after payment confirmation.';
