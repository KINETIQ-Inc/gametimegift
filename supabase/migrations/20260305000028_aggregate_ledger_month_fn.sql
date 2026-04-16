-- =============================================================================
-- Migration: 20260305000028_aggregate_ledger_month_fn
--
-- Creates:
--   function public.aggregate_ledger_month   monthly ledger aggregation for invoicing
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Produces a comprehensive monthly summary of sales and commission activity
-- from the inventory ledger and commission tables. This is the read-only
-- calculation step that feeds the monthly invoice generation pipeline (3E-2+).
--
-- ─── Data sources ────────────────────────────────────────────────────────────
--
--   inventory_ledger_entries  action='sold'     → per-unit revenue by license_body
--                             action='returned' → per-unit returns (commission risk)
--   commission_entries        all statuses       → authoritative commission amounts
--
-- ─── Period boundaries ───────────────────────────────────────────────────────
--
-- Ledger events are bounded by occurred_at (UTC wall-clock, set server-side at
-- insert time). Commission entries are bounded by created_at (inserted at sale
-- time — a reliable proxy for when the commission was earned).
--
-- Both use the same UTC boundaries:
--   period_start = YYYY-MM-01 00:00:00 UTC (inclusive)
--   period_end   = last day of month 23:59:59.999999 UTC (inclusive)
--
-- Using the ledger's occurred_at rather than orders.paid_at ensures every
-- unit that physically changed state in the month is counted, even if the
-- order payment timestamp is in an adjacent period due to processing lag.
--
-- ─── Commission source of truth ──────────────────────────────────────────────
--
-- When aggregating by consultant, commission_cents comes from commission_entries
-- (the authoritative stamped amount) via a LEFT JOIN from ledger entries, NOT
-- from re-computing retail_price_cents × commission_rate. This preserves
-- historical accuracy: a consultant's tier or rate may have changed since the
-- sale, but their commission_entries rows carry the rate in effect at sale time.
--
-- ─── Returned units ──────────────────────────────────────────────────────────
--
-- Returned ledger entries surface units whose commissions may be reversed.
-- Reversals are not automatic — they require a separate admin action.
-- The return data here is informational, giving the invoice engine visibility
-- into the net sales position and flagging commissions at risk.
-- =============================================================================

create or replace function public.aggregate_ledger_month(
  p_year_month  text   -- 'YYYY-MM', e.g. '2026-03'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start  date;
  v_period_end    date;
  v_ts_start      timestamptz;
  v_ts_end        timestamptz;  -- exclusive upper bound

  v_sales_totals      jsonb;
  v_by_license_body   jsonb;
  v_by_consultant     jsonb;
  v_direct_sales      jsonb;
  v_returns_totals    jsonb;
  v_commission_totals jsonb;
begin

  -- ── Parse and validate year_month ─────────────────────────────────────────
  begin
    v_period_start := (p_year_month || '-01')::date;
  exception when others then
    raise exception
      '[GTG] aggregate_ledger_month: invalid year_month ''%''. Expected YYYY-MM (e.g. ''2026-03'').',
      p_year_month;
  end;

  v_period_end := (date_trunc('month', v_period_start) + interval '1 month - 1 day')::date;
  v_ts_start   := v_period_start::timestamptz;
  v_ts_end     := (v_period_end::timestamptz + interval '1 day');  -- exclusive: < v_ts_end

  -- ── Sales totals (all units sold in period) ───────────────────────────────
  select jsonb_build_object(
    'units_sold',         coalesce(count(*), 0),
    'gross_sales_cents',  coalesce(sum(retail_price_cents), 0)
  )
  into v_sales_totals
  from public.inventory_ledger_entries
  where action       = 'sold'
    and occurred_at >= v_ts_start
    and occurred_at <  v_ts_end;

  -- ── Sales by license_body ─────────────────────────────────────────────────
  -- Enables the invoice engine to correlate with royalty obligations.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'license_body',      license_body,
        'units_sold',        units_sold,
        'gross_sales_cents', gross_sales_cents
      )
      order by license_body
    ),
    '[]'::jsonb
  )
  into v_by_license_body
  from (
    select
      license_body::text,
      count(*)                             as units_sold,
      coalesce(sum(retail_price_cents), 0) as gross_sales_cents
    from public.inventory_ledger_entries
    where action       = 'sold'
      and occurred_at >= v_ts_start
      and occurred_at <  v_ts_end
    group by license_body
  ) s;

  -- ── Sales by consultant (with commission amounts from commission_entries) ──
  -- LEFT JOIN brings in the authoritative commission_cents stamped at sale time.
  -- Only units with a non-null consultant_id are included here.
  -- Direct (storefront/admin) sales are summarised separately below.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'consultant_id',          consultant_id,
        'units_sold',             units_sold,
        'gross_sales_cents',      gross_sales_cents,
        'commission_entry_count', commission_entry_count,
        'total_commission_cents', total_commission_cents
      )
      order by gross_sales_cents desc
    ),
    '[]'::jsonb
  )
  into v_by_consultant
  from (
    select
      ile.consultant_id::text,
      count(ile.id)                              as units_sold,
      coalesce(sum(ile.retail_price_cents), 0)   as gross_sales_cents,
      count(ce.id)                               as commission_entry_count,
      coalesce(sum(ce.commission_cents), 0)      as total_commission_cents
    from public.inventory_ledger_entries ile
    left join public.commission_entries ce
      on ce.unit_id = ile.unit_id
    where ile.action        = 'sold'
      and ile.occurred_at  >= v_ts_start
      and ile.occurred_at  <  v_ts_end
      and ile.consultant_id is not null
    group by ile.consultant_id
  ) s;

  -- ── Direct sales (no consultant attribution) ──────────────────────────────
  select jsonb_build_object(
    'units_sold',        coalesce(count(*), 0),
    'gross_sales_cents', coalesce(sum(retail_price_cents), 0)
  )
  into v_direct_sales
  from public.inventory_ledger_entries
  where action        = 'sold'
    and occurred_at  >= v_ts_start
    and occurred_at  <  v_ts_end
    and consultant_id is null;

  -- ── Returns (units returned in period) ───────────────────────────────────
  -- Surfaces commissions at risk of reversal. Commissions on returned units
  -- are not automatically reversed — this is informational.
  select jsonb_build_object(
    'units_returned',           coalesce(count(*), 0),
    'returned_retail_cents',    coalesce(sum(retail_price_cents), 0),
    'consultant_attributed',    coalesce(sum(case when consultant_id is not null then 1 else 0 end), 0)
  )
  into v_returns_totals
  from public.inventory_ledger_entries
  where action       = 'returned'
    and occurred_at >= v_ts_start
    and occurred_at <  v_ts_end;

  -- ── Commission entries by status (created in period) ─────────────────────
  -- commission_entries.created_at is used as the period anchor.
  -- All statuses are included — the invoice engine decides which to act on.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'status',                 status,
        'entry_count',            entry_count,
        'total_commission_cents', total_commission_cents
      )
      order by status
    ),
    '[]'::jsonb
  )
  into v_commission_totals
  from (
    select
      status::text,
      count(*)                               as entry_count,
      coalesce(sum(commission_cents), 0)     as total_commission_cents
    from public.commission_entries
    where created_at >= v_ts_start
      and created_at <  v_ts_end
    group by status
  ) c;

  -- ── Assemble and return ───────────────────────────────────────────────────
  return jsonb_build_object(
    'year_month',         p_year_month,
    'period_start',       v_period_start::text,
    'period_end',         v_period_end::text,
    'sales_totals',       v_sales_totals,
    'by_license_body',    v_by_license_body,
    'by_consultant',      v_by_consultant,
    'direct_sales',       v_direct_sales,
    'returns',            v_returns_totals,
    'commissions',        v_commission_totals
  );

end;
$$;

grant execute on function public.aggregate_ledger_month(text)
  to service_role;

comment on function public.aggregate_ledger_month(text) is
  'Monthly ledger aggregation for the invoice engine. Accepts YYYY-MM and returns '
  'a JSONB summary of: all units sold (by license_body, by consultant, direct), '
  'return activity, and commission entries by status. '
  'Uses inventory_ledger_entries.occurred_at for sales/returns and '
  'commission_entries.created_at for commission data. '
  'Read-only — no writes. Called by the aggregate-ledger-by-month Edge Function.';
