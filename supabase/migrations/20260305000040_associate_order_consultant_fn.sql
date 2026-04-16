-- =============================================================================
-- Migration: 20260305000040_associate_order_consultant_fn
--
-- Creates:
--   function public.associate_order_consultant   manual consultant attribution
--
-- ─── Purpose ──────────────────────────────────────────────────────────────────
--
-- Associates an already-paid order with a consultant when the referral link
-- was not used at checkout. This is the correction path for:
--
--   - Customer placed a storefront_direct order that a consultant facilitated
--     in person or by phone, without using their referral link.
--   - Admin needs to correct consultant attribution after the fact.
--
-- The function is intentionally all-or-nothing: either every line in the order
-- receives a commission entry, or nothing changes. Partial attribution would
-- leave the data in an inconsistent state that is difficult to audit.
--
-- ─── What changes ─────────────────────────────────────────────────────────────
--
--   orders
--     channel          → 'consultant_assisted'
--     consultant_id    → p_consultant_id
--     consultant_name  → p_consultant_name
--     internal_notes   → appended with p_note (if provided)
--
--   order_lines (each non-cancelled line)
--     commission_tier         → p_commission_tier
--     commission_rate         → p_commission_rate
--     commission_cents        → round(retail_price_cents * p_commission_rate)
--     commission_entry_id     → id of newly created commission_entry
--
--   commission_entries (one new row per non-cancelled order_line)
--     Status: 'earned'. Stamped with tier, rate, cents at time of association.
--
--   serialized_units (each unit on a non-cancelled line)
--     consultant_id    → p_consultant_id
--
--   consultant_profiles (via credit_consultant_sale)
--     lifetime_gross_sales_cents  += sum of line retail_price_cents
--     lifetime_commissions_cents  += total_commission_cents
--     pending_payout_cents        += total_commission_cents
--     last_sale_at                 = now()
--
-- ─── Eligibility rules ────────────────────────────────────────────────────────
--
--   Eligible order statuses: paid, fulfilling, fulfilled.
--   Ineligible: draft, pending_payment, payment_failed, cancelled, refunded,
--               fully_returned, partially_returned.
--
--   Rejected if the order already has a consultant_id (prevents double attribution).
--
--   Only order_lines with status NOT IN ('cancelled') receive commission entries.
--   Lines already cancelled before this call produce no commission.
--
-- ─── What does NOT change ─────────────────────────────────────────────────────
--
--   inventory_ledger_entries — append-only; historical 'sold' entries are not
--     modified. The audit trail of the manual association is the commission_entries
--     records and the updated orders row.
--
-- ─── Parameters ───────────────────────────────────────────────────────────────
--
--   p_order_id         uuid                  — target order
--   p_consultant_id    uuid                  — consultant_profiles.id
--   p_consultant_name  text                  — legal name (denormalized on entries)
--   p_commission_tier  public.commission_tier — tier at time of association
--   p_commission_rate  numeric(5,4)          — rate at time of association
--   p_performed_by     uuid                  — admin auth.users.id (audit)
--   p_note             text (default null)   — optional internal note appended to
--                                              orders.internal_notes
--
-- ─── Returns ──────────────────────────────────────────────────────────────────
--
--   TABLE(
--     order_id               uuid,
--     order_number           text,
--     lines_attributed       integer,    -- count of lines that received commission
--     total_commission_cents integer     -- sum of all commission_cents created
--   )
--
-- ─── Raises ───────────────────────────────────────────────────────────────────
--
--   [GTG] associate_order_consultant: order not found
--   [GTG] associate_order_consultant: order status not eligible
--   [GTG] associate_order_consultant: order already attributed to a consultant
--   [GTG] associate_order_consultant: no attributable lines found
--
-- Caller:
--   associate-order-consultant Edge Function via admin.rpc(...)
-- =============================================================================

create or replace function public.associate_order_consultant(
  p_order_id        uuid,
  p_consultant_id   uuid,
  p_consultant_name text,
  p_commission_tier public.commission_tier,
  p_commission_rate numeric(5, 4),
  p_performed_by    uuid,
  p_note            text default null
)
returns table (
  order_id               uuid,
  order_number           text,
  lines_attributed       integer,
  total_commission_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Statuses eligible for manual consultant attribution.
  ELIGIBLE_STATUSES constant text[] := array['paid', 'fulfilling', 'fulfilled'];

  v_order             record;
  v_line              record;
  v_commission_cents  integer;
  v_commission_entry_id uuid;
  v_lines_attributed  integer := 0;
  v_total_commission  integer := 0;
  v_gross_sales_total integer := 0;
  v_updated_notes     text;
begin

  -- ── Row lock: order ───────────────────────────────────────────────────────────
  -- Prevents concurrent status changes or double-attribution while we work.

  select
    id,
    order_number,
    status,
    channel,
    consultant_id,
    internal_notes,
    total_cents
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '[GTG] associate_order_consultant: order not found (id=%).', p_order_id;
  end if;

  -- ── Guard: status must be eligible ───────────────────────────────────────────

  if v_order.status::text != all(ELIGIBLE_STATUSES) then
    raise exception
      '[GTG] associate_order_consultant: order ''%'' has status ''%'', which is not '
      'eligible for manual consultant attribution. Eligible statuses: paid, fulfilling, fulfilled.',
      v_order.order_number, v_order.status;
  end if;

  -- ── Guard: must not already have a consultant ────────────────────────────────

  if v_order.consultant_id is not null then
    raise exception
      '[GTG] associate_order_consultant: order ''%'' is already attributed to consultant '
      'id=%. Use a correction procedure to change attribution on an already-attributed order.',
      v_order.order_number, v_order.consultant_id;
  end if;

  -- ── Update orders ────────────────────────────────────────────────────────────
  -- Must update channel, consultant_id, and consultant_name together to satisfy
  -- the orders_consultant_channel_consistent check constraint atomically.

  v_updated_notes := case
    when p_note is not null and v_order.internal_notes is not null
      then v_order.internal_notes || E'\n' || '[Manual attribution ' || now()::date || '] ' || p_note
    when p_note is not null
      then '[Manual attribution ' || now()::date || '] ' || p_note
    else v_order.internal_notes
  end;

  update public.orders
  set
    channel         = 'consultant_assisted',
    consultant_id   = p_consultant_id,
    consultant_name = p_consultant_name,
    internal_notes  = v_updated_notes,
    updated_at      = now()
  where id = p_order_id;

  -- ── Process each attributable order_line ─────────────────────────────────────
  -- Non-cancelled lines each receive a commission_entry and updated commission
  -- fields. Cancelled lines are skipped — no commission obligation on cancelled lines.

  for v_line in
    select
      id          as line_id,
      unit_id,
      serial_number,
      sku,
      product_name,
      retail_price_cents
    from public.order_lines
    where order_id = p_order_id
      and status   != 'cancelled'
    order by line_number asc
  loop

    -- commission_cents = retail_price_cents × rate, rounded to nearest cent.
    v_commission_cents := round(v_line.retail_price_cents * p_commission_rate)::integer;

    -- Insert commission_entry — stamped with tier, rate, and cents at time of association.
    -- commission_entries.unit_unique will raise if a commission entry already exists
    -- for this unit, preventing double-commission on the same physical unit.
    insert into public.commission_entries (
      consultant_id,
      consultant_name,
      unit_id,
      order_id,
      serial_number,
      sku,
      product_name,
      retail_price_cents,
      commission_tier,
      commission_rate,
      commission_cents,
      status
    ) values (
      p_consultant_id,
      p_consultant_name,
      v_line.unit_id,
      p_order_id,
      v_line.serial_number,
      v_line.sku,
      v_line.product_name,
      v_line.retail_price_cents,
      p_commission_tier,
      p_commission_rate,
      v_commission_cents,
      'earned'
    )
    returning id into v_commission_entry_id;

    -- Update order_line commission fields.
    -- All three commission columns (tier/rate/cents) set together per the
    -- order_lines_commission_fields_consistent check constraint.
    update public.order_lines
    set
      commission_tier     = p_commission_tier,
      commission_rate     = p_commission_rate,
      commission_cents    = v_commission_cents,
      commission_entry_id = v_commission_entry_id,
      updated_at          = now()
    where id = v_line.line_id;

    -- Update serialized_units.consultant_id to link the physical unit to the consultant.
    update public.serialized_units
    set
      consultant_id = p_consultant_id,
      updated_at    = now()
    where id = v_line.unit_id;

    v_lines_attributed := v_lines_attributed + 1;
    v_total_commission := v_total_commission + v_commission_cents;
    v_gross_sales_total := v_gross_sales_total + v_line.retail_price_cents;

  end loop;

  -- ── Guard: must have found at least one attributable line ────────────────────

  if v_lines_attributed = 0 then
    raise exception
      '[GTG] associate_order_consultant: order ''%'' has no attributable lines. '
      'All lines are cancelled. No commission entries were created.',
      v_order.order_number;
  end if;

  -- ── Credit consultant running totals ─────────────────────────────────────────
  -- Atomically increments lifetime_gross_sales_cents, lifetime_commissions_cents,
  -- and pending_payout_cents. Uses the same function called by stripe-webhook (5B-2).

  perform public.credit_consultant_sale(
    p_consultant_id     => p_consultant_id,
    p_gross_sales_cents => v_gross_sales_total,
    p_commission_cents  => v_total_commission
  );

  return query
  select
    p_order_id,
    v_order.order_number,
    v_lines_attributed,
    v_total_commission;

end;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.associate_order_consultant(
  uuid, uuid, text, public.commission_tier, numeric, uuid, text
) to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.associate_order_consultant(
  uuid, uuid, text, public.commission_tier, numeric, uuid, text
) is
  'Manually attributes a paid order to a consultant when the referral link was not '
  'used at checkout. Updates orders, order_lines, commission_entries, serialized_units, '
  'and consultant_profiles running totals in a single transaction. '
  'Eligible order statuses: paid, fulfilling, fulfilled. '
  'Raises if the order already has a consultant or has no non-cancelled lines. '
  'Called by the associate-order-consultant Edge Function.';
