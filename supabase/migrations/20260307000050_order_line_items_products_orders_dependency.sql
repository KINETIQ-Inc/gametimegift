-- =============================================================================
-- Migration: 20260307000050_order_line_items_products_orders_dependency
--
-- Phase 4A-6: order_line_items
-- Objective:
--   - Add explicit dependency on products in addition to orders.
--   - Enforce that any product-linked line item references a product that is
--     actually present on that order.
-- =============================================================================

-- ─── Schema: product dependency ──────────────────────────────────────────────
-- Nullable by design:
--   shipping/tax/order-level discounts are not product-scoped.
--   product_id is populated only for product-scoped fees/adjustments/credits.

alter table public.order_line_items
  add column if not exists product_id uuid
    references public.products (id);

create index if not exists order_line_items_product_id_idx
  on public.order_line_items (product_id)
  where product_id is not null;

-- ─── Integrity: product_id must belong to the same order ────────────────────
-- If product_id is set on an order_line_item, at least one order_lines row on
-- that same order must reference a serialized_unit for the same product_id.
-- This prevents attaching product-scoped adjustments to unrelated products.

create or replace function public.assert_order_line_item_product_belongs_to_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.order_lines ol
    join public.serialized_units su on su.id = ol.unit_id
    where ol.order_id = new.order_id
      and su.product_id = new.product_id
  ) then
    raise exception
      '[GTG] order_line_items.product_id (%) is not present on order_id (%). '
      'product_id must correspond to at least one order line on the same order.',
      new.product_id, new.order_id;
  end if;

  return new;
end;
$$;

drop trigger if exists order_line_items_validate_product_scope
  on public.order_line_items;

create trigger order_line_items_validate_product_scope
  before insert or update of order_id, product_id
  on public.order_line_items
  for each row
  execute function public.assert_order_line_item_product_belongs_to_order();

comment on column public.order_line_items.product_id is
  'Optional product scope for this non-unit invoice line. '
  'When set, must match a product present on at least one order_lines row '
  'for the same order_id.';

