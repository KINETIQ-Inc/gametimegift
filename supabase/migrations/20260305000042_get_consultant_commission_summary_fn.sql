-- =============================================================================
-- Migration: 20260305000042_get_consultant_commission_summary_fn
--
-- Creates:
--   function public.get_consultant_commission_summary   period commission aggregate
--
-- ─── Purpose ──────────────────────────────────────────────────────────────────
--
-- Aggregates commission_entries for a consultant over a caller-supplied time
-- window. Returns entry counts and commission totals broken down by status
-- (earned / paid / voided) so the consultant portal dashboard can display
-- what they've earned, what has been paid out, and what has been reversed.
--
-- Called by the get-consultant-commission-earned Edge Function (6B-2).
--
-- ─── Design notes ─────────────────────────────────────────────────────────────
--
-- commission_entries is the source of truth for per-unit commission records.
-- The function filters on commission_entries.created_at (when the commission
-- was recorded) rather than the parent order's paid_at so the period bounds
-- match the consultant's commission activity, not the order date.
--
-- commission_entries already denormalises product_name, serial_number, sku,
-- retail_price_cents, commission_tier, and commission_rate. No join to orders
-- or order_lines is required for aggregation.
--
-- The function always returns exactly one row. All sums COALESCE to 0 so the
-- caller does not need null-checks.
--
-- ─── Parameters ───────────────────────────────────────────────────────────────
--
--   p_consultant_id   uuid          — consultant_profiles.id (never null)
--   p_start_at        timestamptz   — inclusive lower bound (created_at >= ?)
--   p_end_at          timestamptz   — exclusive upper bound (created_at <  ?)
--
-- ─── Returns ──────────────────────────────────────────────────────────────────
--
--   TABLE(
--     entries_count   bigint,   -- total non-voided commission entries in period
--     earned_cents    bigint,   -- sum of commission_cents where status = 'earned'
--     paid_cents      bigint,   -- sum of commission_cents where status = 'paid'
--     voided_cents    bigint,   -- sum of commission_cents where status = 'voided'
--   )
--
--   net_cents (earned + paid, i.e. all non-voided) is computed by the caller.
--
-- Caller:
--   get-consultant-commission-earned Edge Function via admin.rpc(...)
-- =============================================================================

create or replace function public.get_consultant_commission_summary(
  p_consultant_id uuid,
  p_start_at      timestamptz,
  p_end_at        timestamptz
)
returns table (
  entries_count bigint,
  earned_cents  bigint,
  paid_cents    bigint,
  voided_cents  bigint
)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::bigint                                                               as entries_count,
    coalesce(sum(commission_cents) filter (where status = 'earned'), 0)::bigint   as earned_cents,
    coalesce(sum(commission_cents) filter (where status = 'paid'),   0)::bigint   as paid_cents,
    coalesce(sum(commission_cents) filter (where status = 'voided'), 0)::bigint   as voided_cents
  from public.commission_entries
  where consultant_id = p_consultant_id
    and created_at   >= p_start_at
    and created_at    < p_end_at;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.get_consultant_commission_summary(
  uuid, timestamptz, timestamptz
) to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.get_consultant_commission_summary(
  uuid, timestamptz, timestamptz
) is
  'Aggregates commission_entries for a consultant over a time window. '
  'Returns entry count and commission totals split by status (earned/paid/voided). '
  'Filters on commission_entries.created_at (commission recording date). '
  'Always returns exactly one row; all sums coalesce to 0. '
  'Called by the get-consultant-commission-earned Edge Function.';
