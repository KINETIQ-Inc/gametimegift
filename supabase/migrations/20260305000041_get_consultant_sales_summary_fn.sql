-- =============================================================================
-- Migration: 20260305000041_get_consultant_sales_summary_fn
--
-- Creates:
--   function public.get_consultant_sales_summary   period sales aggregate
--
-- ─── Purpose ──────────────────────────────────────────────────────────────────
--
-- Returns a single-row aggregate of a consultant's sales within a UTC timestamp
-- range: order count, units sold, gross sales, and commission totals. Used by
-- the 6B-1 Units Sold dashboard widget to populate period summary figures.
--
-- Performing the aggregation in the DB rather than in the Edge Function ensures
-- O(1) round-trips regardless of how many orders fall in the period, and avoids
-- transferring potentially hundreds of rows across the network for summation.
--
-- ─── Filters ──────────────────────────────────────────────────────────────────
--
-- An order is included when ALL of the following hold:
--   - orders.consultant_id  = p_consultant_id
--   - orders.channel        = 'consultant_assisted'
--   - orders.paid_at        >= p_start_at  AND  < p_end_at
--   - orders.status         NOT IN (cancelled, refunded, fully_returned,
--                                   payment_failed, pending_payment, draft)
--
-- An order_line is included when:
--   - order_lines.status != 'cancelled'
--
-- ─── Returns ──────────────────────────────────────────────────────────────────
--
--   TABLE(
--     orders_count      bigint,   — distinct orders matching the filter
--     units_sold        bigint,   — non-cancelled order_lines in those orders
--     gross_sales_cents bigint,   — SUM of order_lines.retail_price_cents
--     commission_cents  bigint    — SUM of order_lines.commission_cents
--   )
--
-- Always returns exactly one row. Columns are 0 when no matching data exists.
--
-- Caller:
--   get-consultant-units-sold Edge Function via admin.rpc(...)
-- =============================================================================

create or replace function public.get_consultant_sales_summary(
  p_consultant_id uuid,
  p_start_at      timestamptz,
  p_end_at        timestamptz
)
returns table (
  orders_count      bigint,
  units_sold        bigint,
  gross_sales_cents bigint,
  commission_cents  bigint
)
language sql
security definer
set search_path = public
as $$
  select
    count(distinct o.id)::bigint                        as orders_count,
    count(ol.id)::bigint                                as units_sold,
    coalesce(sum(ol.retail_price_cents), 0)::bigint     as gross_sales_cents,
    coalesce(sum(ol.commission_cents),   0)::bigint     as commission_cents
  from public.orders o
  join public.order_lines ol
    on  ol.order_id = o.id
    and ol.status  != 'cancelled'
  where o.consultant_id = p_consultant_id
    and o.channel       = 'consultant_assisted'
    and o.paid_at       >= p_start_at
    and o.paid_at        < p_end_at
    and o.status not in (
      'draft',
      'pending_payment',
      'payment_failed',
      'cancelled',
      'refunded',
      'fully_returned'
    );
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.get_consultant_sales_summary(uuid, timestamptz, timestamptz)
  to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.get_consultant_sales_summary(uuid, timestamptz, timestamptz) is
  'Returns a single-row aggregate of a consultant''s sales within a UTC timestamp '
  'range: orders_count, units_sold, gross_sales_cents, commission_cents. '
  'Excludes cancelled/refunded/failed orders and cancelled lines. '
  'Always returns one row; all columns are 0 when no data matches. '
  'Called by the get-consultant-units-sold Edge Function (6B-1).';
