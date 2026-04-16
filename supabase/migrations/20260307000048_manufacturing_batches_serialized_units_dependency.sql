-- =============================================================================
-- Migration: 20260307000048_manufacturing_batches_serialized_units_dependency
--
-- Phase 4A-4: manufacturing_batches
-- Objective:
--   - Harden serialized_units.batch_id dependency.
--   - Ensure unit snapshot fields remain consistent with the referenced batch.
-- =============================================================================

-- ─── Integrity: unit ↔ batch consistency ─────────────────────────────────────
-- If a unit has batch_id, the following must match the batch record:
--   product_id, sku, license_body
--
-- This protects shipment-level traceability from drift during manual updates.

create or replace function public.assert_serialized_unit_batch_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.manufacturing_batches%rowtype;
begin
  if new.batch_id is null then
    return new;
  end if;

  select *
  into v_batch
  from public.manufacturing_batches
  where id = new.batch_id;

  -- Defensive guard; FK should already enforce existence.
  if not found then
    raise exception
      '[GTG] serialized_units.batch_id references missing manufacturing batch id=%.',
      new.batch_id;
  end if;

  if new.product_id is distinct from v_batch.product_id then
    raise exception
      '[GTG] serialized_units.product_id must match manufacturing_batches.product_id for batch_id=%. '
      'Expected %, got %.',
      new.batch_id, v_batch.product_id, new.product_id;
  end if;

  if new.sku is distinct from v_batch.sku then
    raise exception
      '[GTG] serialized_units.sku must match manufacturing_batches.sku for batch_id=%. '
      'Expected "%", got "%".',
      new.batch_id, v_batch.sku, new.sku;
  end if;

  if new.license_body is distinct from v_batch.license_body then
    raise exception
      '[GTG] serialized_units.license_body must match manufacturing_batches.license_body for batch_id=%. '
      'Expected "%", got "%".',
      new.batch_id, v_batch.license_body, new.license_body;
  end if;

  return new;
end;
$$;

drop trigger if exists serialized_units_assert_batch_consistency
  on public.serialized_units;

create trigger serialized_units_assert_batch_consistency
  before insert or update of batch_id, product_id, sku, license_body
  on public.serialized_units
  for each row
  execute function public.assert_serialized_unit_batch_consistency();

