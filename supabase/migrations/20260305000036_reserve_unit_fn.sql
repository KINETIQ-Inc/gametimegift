-- =============================================================================
-- Migration: 20260305000036_reserve_unit_fn
--
-- Creates:
--   function public.reserve_unit   atomic unit reservation for checkout
--
-- ─── Purpose ──────────────────────────────────────────────────────────────────
--
-- Atomically selects one available unit for a product and transitions it to
-- 'reserved' status, blocking it from concurrent checkout sessions.
-- Called by the create-checkout-session Edge Function when a customer
-- initiates a Stripe Checkout Session.
--
-- ─── FIFO + SKIP LOCKED ───────────────────────────────────────────────────────
--
-- Units are selected in FIFO order (received_at ASC) to turn over older
-- stock first. FOR UPDATE SKIP LOCKED is used so that concurrent reservation
-- requests for the same product skip units already being reserved by another
-- session, rather than blocking and potentially deadlocking. This means two
-- simultaneous checkouts for the same product will each claim a different unit
-- without either waiting for the other's transaction to commit.
--
-- ─── Returns ──────────────────────────────────────────────────────────────────
--
--   TABLE(
--     unit_id       uuid,
--     serial_number text,
--     sku           text,
--     product_name  text,
--     license_body  license_body,
--     royalty_rate  numeric
--   )
--
-- Raises:
--   [GTG] reserve_unit: no available units  — product out of stock
--   [GTG] reserve_unit: unit not found      — internal consistency error
--
-- Caller:
--   create-checkout-session Edge Function via admin.rpc('reserve_unit', {...}).
-- =============================================================================

create or replace function public.reserve_unit(
  p_product_id  uuid,
  p_reserved_by uuid
)
returns table (
  unit_id       uuid,
  serial_number text,
  sku           text,
  product_name  text,
  license_body  public.license_body,
  royalty_rate  numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit record;
  v_now  timestamptz := now();
begin

  -- ── Select and row-lock one available unit ────────────────────────────────────
  -- FIFO: oldest received stock first (turns over inventory evenly).
  -- SKIP LOCKED: concurrent reservations for the same product claim different
  -- units immediately instead of queuing behind each other's locks.

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
  where product_id = p_product_id
    and status     = 'available'
  order by received_at asc
  limit 1
  for update skip locked;

  if not found then
    raise exception
      '[GTG] reserve_unit: no available units for product (id=%). '
      'The product is currently out of stock.',
      p_product_id;
  end if;

  -- ── Update unit status to reserved ───────────────────────────────────────────
  -- The status transition trigger (migration 18) validates that
  -- available → reserved is a permitted transition.

  update public.serialized_units
  set
    status     = 'reserved',
    updated_at = v_now
  where id = v_unit.id;

  -- ── Append ledger entry ───────────────────────────────────────────────────────
  -- Delegates the validated INSERT to append_ledger_entry (migration 20).
  -- No order_id yet — it is set when payment is confirmed and the order created.

  perform public.append_ledger_entry(
    p_unit_id            => v_unit.id,
    p_action             => 'reserved',
    p_performed_by       => p_reserved_by,
    p_serial_number      => v_unit.serial_number,
    p_sku                => v_unit.sku,
    p_product_name       => v_unit.product_name,
    p_from_status        => 'available',
    p_to_status          => 'reserved',
    p_license_body       => v_unit.license_body,
    p_royalty_rate       => v_unit.royalty_rate
  );

  -- ── Return the reserved unit ──────────────────────────────────────────────────

  return query
  select
    v_unit.id,
    v_unit.serial_number,
    v_unit.sku,
    v_unit.product_name,
    v_unit.license_body,
    v_unit.royalty_rate;

end;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.reserve_unit(uuid, uuid)
  to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.reserve_unit(uuid, uuid) is
  'Atomically selects the oldest available unit for a product (FIFO) and '
  'transitions it to ''reserved'' status. Uses FOR UPDATE SKIP LOCKED so '
  'concurrent checkout sessions claim different units without blocking. '
  'Appends a ''reserved'' inventory_ledger_entries row via append_ledger_entry. '
  'Raises [GTG] reserve_unit: no available units if the product is out of stock. '
  'Called exclusively by the create-checkout-session Edge Function.';
