-- =============================================================================
-- Migration: 20260307000049_orders_order_line_items_dependency
--
-- Phase 4A-5: orders
-- Objective:
--   - Harden order dependency for order_line_items.order_id.
--   - Prevent reassignment of invoice identity fields after creation.
-- =============================================================================

-- order_line_items are invoice snapshots tied to one order.
-- Reparenting to a different order corrupts financial auditability.
-- Enforce immutability for:
--   order_id, line_number, type, amount_cents
-- (description/reference_id remain editable for administrative corrections.)

create or replace function public.prevent_order_line_item_identity_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.order_id is distinct from new.order_id then
    raise exception
      '[GTG] order_line_items.order_id is immutable. Cannot move line id=% from order_id=% to order_id=%.',
      old.id, old.order_id, new.order_id;
  end if;

  if old.line_number is distinct from new.line_number then
    raise exception
      '[GTG] order_line_items.line_number is immutable for line id=%. '
      'Void/reverse with a new adjustment line instead of re-sequencing.',
      old.id;
  end if;

  if old.type is distinct from new.type then
    raise exception
      '[GTG] order_line_items.type is immutable for line id=%. '
      'Insert a reversing adjustment and a new line item.',
      old.id;
  end if;

  if old.amount_cents is distinct from new.amount_cents then
    raise exception
      '[GTG] order_line_items.amount_cents is immutable for line id=%. '
      'Insert an offsetting adjustment line to correct invoice totals.',
      old.id;
  end if;

  return new;
end;
$$;

drop trigger if exists order_line_items_immutable_identity
  on public.order_line_items;

create trigger order_line_items_immutable_identity
  before update on public.order_line_items
  for each row
  execute function public.prevent_order_line_item_identity_update();

