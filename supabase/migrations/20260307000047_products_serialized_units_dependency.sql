-- =============================================================================
-- Migration: 20260307000047_products_serialized_units_dependency
--
-- Phase 4A-3: products
-- Objective:
--   - Harden product integrity for serialized_units.product_id references.
--   - Enforce immutable product linkage and canonical denormalized snapshots.
-- =============================================================================

-- ─── Performance: product → units lookups ───────────────────────────────────
-- Common paths:
--   - available count by product
--   - product inventory drill-down
--   - joins from products to serialized_units
create index if not exists serialized_units_product_id_idx
  on public.serialized_units (product_id);

-- ─── Integrity: canonical product snapshot on unit rows ─────────────────────
-- serialized_units stores denormalized product fields (sku, product_name,
-- license_body, cost_cents). Ensure those fields match the referenced product.

create or replace function public.assert_serialized_unit_product_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
begin
  select *
  into v_product
  from public.products
  where id = new.product_id;

  -- Defensive guard; FK should already guarantee existence.
  if not found then
    raise exception
      '[GTG] serialized_units.product_id references missing product id=%.',
      new.product_id;
  end if;

  -- Product linkage is immutable once a unit row exists.
  if tg_op = 'UPDATE' and old.product_id is distinct from new.product_id then
    raise exception
      '[GTG] serialized_units.product_id is immutable. '
      'Cannot change unit id=% from product_id=% to product_id=%.',
      old.id, old.product_id, new.product_id;
  end if;

  if new.sku is distinct from v_product.sku then
    raise exception
      '[GTG] serialized_units.sku must match products.sku for product_id=%. '
      'Expected "%", got "%".',
      new.product_id, v_product.sku, new.sku;
  end if;

  if new.product_name is distinct from v_product.name then
    raise exception
      '[GTG] serialized_units.product_name must match products.name for product_id=%. '
      'Expected "%", got "%".',
      new.product_id, v_product.name, new.product_name;
  end if;

  if new.license_body is distinct from v_product.license_body then
    raise exception
      '[GTG] serialized_units.license_body must match products.license_body for product_id=%. '
      'Expected "%", got "%".',
      new.product_id, v_product.license_body, new.license_body;
  end if;

  if new.cost_cents is distinct from v_product.cost_cents then
    raise exception
      '[GTG] serialized_units.cost_cents must match products.cost_cents for product_id=%. '
      'Expected %, got %.',
      new.product_id, v_product.cost_cents, new.cost_cents;
  end if;

  return new;
end;
$$;

drop trigger if exists serialized_units_assert_product_snapshot
  on public.serialized_units;

create trigger serialized_units_assert_product_snapshot
  before insert or update of product_id, sku, product_name, license_body, cost_cents
  on public.serialized_units
  for each row
  execute function public.assert_serialized_unit_product_snapshot();

