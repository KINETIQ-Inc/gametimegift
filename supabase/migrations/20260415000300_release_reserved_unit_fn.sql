-- =============================================================================
-- Migration: 20260415000300_release_reserved_unit_fn
--
-- Creates:
--   function public.release_reserved_unit   atomic checkout reservation release
--
-- Purpose:
--   Releases a reserved serialized unit back to available inventory when a
--   checkout attempt fails before payment can begin. Clears the temporary
--   order attachment, restores availability, and records a
--   reservation_released ledger entry tied to the abandoned order context.
-- =============================================================================

create or replace function public.release_reserved_unit(
  p_unit_id uuid,
  p_order_id uuid,
  p_released_by uuid,
  p_reason text default null
)
returns table (
  unit_id uuid,
  serial_number text,
  order_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit record;
  v_now timestamptz := now();
begin
  if p_unit_id is null then
    raise exception '[GTG] release_reserved_unit: p_unit_id is required.';
  end if;

  if p_order_id is null then
    raise exception '[GTG] release_reserved_unit: p_order_id is required.';
  end if;

  if p_released_by is null then
    raise exception '[GTG] release_reserved_unit: p_released_by is required.';
  end if;

  select
    id,
    serial_number,
    sku,
    product_name,
    status,
    order_id,
    consultant_id,
    license_body,
    royalty_rate
  into v_unit
  from public.serialized_units
  where id = p_unit_id
  for update;

  if not found then
    raise exception '[GTG] release_reserved_unit: unit not found (id=%).', p_unit_id;
  end if;

  if v_unit.status <> 'reserved' then
    raise exception
      '[GTG] release_reserved_unit: unit ''%'' has status ''%'' and cannot be released.',
      p_unit_id, v_unit.status;
  end if;

  if v_unit.order_id is distinct from p_order_id then
    raise exception
      '[GTG] release_reserved_unit: unit ''%'' is attached to order ''%'' not ''%''.',
      p_unit_id, v_unit.order_id, p_order_id;
  end if;

  update public.serialized_units
  set
    status = 'available',
    order_id = null,
    consultant_id = null,
    retail_price_cents = null,
    updated_at = v_now
  where id = v_unit.id;

  perform public.append_ledger_entry(
    p_unit_id            => v_unit.id,
    p_action             => 'reservation_released',
    p_performed_by       => p_released_by,
    p_serial_number      => v_unit.serial_number,
    p_sku                => v_unit.sku,
    p_product_name       => v_unit.product_name,
    p_from_status        => 'reserved',
    p_to_status          => 'available',
    p_license_body       => v_unit.license_body,
    p_royalty_rate       => v_unit.royalty_rate,
    p_order_id           => p_order_id,
    p_consultant_id      => v_unit.consultant_id,
    p_reason             => p_reason
  );

  return query
  select
    v_unit.id,
    v_unit.serial_number,
    p_order_id;
end;
$$;

grant execute on function public.release_reserved_unit(uuid, uuid, uuid, text)
  to service_role;

comment on function public.release_reserved_unit(uuid, uuid, uuid, text) is
  'Atomically releases a reserved serialized unit back to available inventory '
  'for a failed pre-payment checkout attempt, clears temporary order linkage, '
  'and records a reservation_released ledger entry.';
