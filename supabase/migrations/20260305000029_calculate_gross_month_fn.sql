-- =============================================================================
-- Migration: 20260305000029_calculate_gross_month_fn
--
-- Creates:
--   function public.calculate_gross_month   monthly gross/net financial calculation
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Extends the raw monthly ledger aggregation (aggregate_ledger_month) with
-- derived gross/net figures needed by the invoice generation pipeline.
--
-- The key additions over the 3E-1 aggregation:
--   1. Returns broken down by license_body → per-licensor net revenue
--   2. Commission reversals attributed by reversed_at → period reversal total
--   3. Per-consultant gross, reversals, net, and approved-payable amounts
--   4. Platform-level gross/net summary across all dimensions
--
-- ─── Period boundary semantics ────────────────────────────────────────────────
--
--   Sold/returned events:  inventory_ledger_entries.occurred_at (UTC)
--   Commission accruals:   commission_entries.created_at (sale time proxy)
--   Commission reversals:  commission_entries.reversed_at (when reversed)
--
-- Using reversed_at (not created_at) for reversals means a reversal processed
-- in March is a March deduction regardless of when the original commission
-- was earned. This mirrors standard accrual accounting: charges and credits
-- are recognised in the period they are executed.
--
-- ─── Gross vs. net ────────────────────────────────────────────────────────────
--
--   Gross commission = sum(commission_cents) for all entries created this period
--                      (any status — includes entries subsequently reversed)
--
--   Reversals        = sum(commission_cents) for entries whose reversed_at
--                      falls in this period (may include prior-period accruals)
--
--   Net commission   = gross_accrued − reversals_this_period
--
--   Net payable      = sum(commission_cents) WHERE status = 'approved'
--                      AND created_at in period (cleared for payout)
--
--   Net held         = sum(commission_cents) WHERE status = 'held'
--                      AND created_at in period (withheld; not yet payable)
--
-- ─── Negative net ────────────────────────────────────────────────────────────
--
-- It is possible for net_commission_cents to be negative in a period with few
-- new sales but many reversals from prior months. This is a valid and important
-- signal for the invoice engine — it may indicate clawback obligations or a
-- period of unusually high return activity. The invoice engine must handle
-- negative net values explicitly.
-- =============================================================================

create or replace function public.calculate_gross_month(
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

  -- Revenue
  v_gross_sales_cents   bigint;
  v_by_license_body     jsonb;

  -- Commissions
  v_commission_accrued  jsonb;    -- by_consultant accruals
  v_commission_reversed jsonb;    -- by_consultant reversals
  v_commission_totals   jsonb;    -- platform-level totals

  -- Assembled sections
  v_revenue_section     jsonb;
  v_commission_section  jsonb;
begin

  -- ── Parse and validate year_month ─────────────────────────────────────────
  begin
    v_period_start := (p_year_month || '-01')::date;
  exception when others then
    raise exception
      '[GTG] calculate_gross_month: invalid year_month ''%''. Expected YYYY-MM (e.g. ''2026-03'').',
      p_year_month;
  end;

  v_period_end := (date_trunc('month', v_period_start) + interval '1 month - 1 day')::date;
  v_ts_start   := v_period_start::timestamptz;
  v_ts_end     := (v_period_end::timestamptz + interval '1 day');  -- exclusive

  -- ── Revenue: sales and returns by license_body ────────────────────────────
  -- Join sold and returned aggregates on license_body. A license_body with
  -- only sales and no returns will still appear (LEFT JOIN returns row with
  -- returns = 0). A license_body with only returns (unusual) will appear via
  -- the FULL OUTER JOIN.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'license_body',       coalesce(s.license_body, r.license_body),
        'gross_sales_cents',  coalesce(s.gross_sales_cents, 0),
        'returns_cents',      coalesce(r.returns_cents, 0),
        'net_sales_cents',    coalesce(s.gross_sales_cents, 0) - coalesce(r.returns_cents, 0)
      )
      order by coalesce(s.license_body, r.license_body)
    ),
    '[]'::jsonb
  )
  into v_by_license_body
  from (
    select
      license_body::text,
      coalesce(sum(retail_price_cents), 0) as gross_sales_cents
    from public.inventory_ledger_entries
    where action       = 'sold'
      and occurred_at >= v_ts_start
      and occurred_at <  v_ts_end
    group by license_body
  ) s
  full outer join (
    select
      license_body::text,
      coalesce(sum(retail_price_cents), 0) as returns_cents
    from public.inventory_ledger_entries
    where action       = 'returned'
      and occurred_at >= v_ts_start
      and occurred_at <  v_ts_end
    group by license_body
  ) r on r.license_body = s.license_body;

  -- Platform gross sales total (for revenue section header)
  select coalesce(sum(retail_price_cents), 0)
  into v_gross_sales_cents
  from public.inventory_ledger_entries
  where action       = 'sold'
    and occurred_at >= v_ts_start
    and occurred_at <  v_ts_end;

  -- Assemble revenue section
  select jsonb_build_object(
    'gross_sales_cents',  v_gross_sales_cents,
    'returns_cents',      coalesce(
      (select sum(retail_price_cents)
       from public.inventory_ledger_entries
       where action = 'returned' and occurred_at >= v_ts_start and occurred_at < v_ts_end),
      0
    ),
    'net_sales_cents',    v_gross_sales_cents - coalesce(
      (select sum(retail_price_cents)
       from public.inventory_ledger_entries
       where action = 'returned' and occurred_at >= v_ts_start and occurred_at < v_ts_end),
      0
    ),
    'by_license_body',    v_by_license_body
  ) into v_revenue_section;

  -- ── Commission: accruals per consultant (created this period) ────────────
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'consultant_id',           consultant_id,
        'entry_count',             entry_count,
        'gross_accrued_cents',     gross_accrued_cents,
        'approved_payable_cents',  approved_payable_cents,
        'held_cents',              held_cents
      )
      order by gross_accrued_cents desc
    ),
    '[]'::jsonb
  )
  into v_commission_accrued
  from (
    select
      consultant_id::text,
      count(*)                                                                              as entry_count,
      coalesce(sum(commission_cents), 0)                                                    as gross_accrued_cents,
      coalesce(sum(commission_cents) filter (where status = 'approved'), 0)                as approved_payable_cents,
      coalesce(sum(commission_cents) filter (where status = 'held'), 0)                   as held_cents
    from public.commission_entries
    where created_at >= v_ts_start
      and created_at <  v_ts_end
    group by consultant_id
  ) a;

  -- ── Commission: reversals per consultant (reversed_at this period) ────────
  -- reversed_at captures when the reversal was processed, independently of
  -- when the original commission was created. This may include entries from
  -- prior periods being reversed in the current month.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'consultant_id',    consultant_id,
        'reversal_count',   reversal_count,
        'reversal_cents',   reversal_cents
      )
      order by reversal_cents desc
    ),
    '[]'::jsonb
  )
  into v_commission_reversed
  from (
    select
      consultant_id::text,
      count(*)                               as reversal_count,
      coalesce(sum(commission_cents), 0)     as reversal_cents
    from public.commission_entries
    where status        = 'reversed'
      and reversed_at  >= v_ts_start
      and reversed_at  <  v_ts_end
    group by consultant_id
  ) r;

  -- ── Commission: platform-level totals ─────────────────────────────────────
  select jsonb_build_object(
    -- All commissions accrued this period (any status)
    'gross_accrued_cents', coalesce(
      (select sum(commission_cents) from public.commission_entries
       where created_at >= v_ts_start and created_at < v_ts_end), 0),

    -- Reversals processed this period (by reversed_at, any create period)
    'reversals_this_period_cents', coalesce(
      (select sum(commission_cents) from public.commission_entries
       where status = 'reversed' and reversed_at >= v_ts_start and reversed_at < v_ts_end), 0),

    -- Net: accrued this period minus reversals this period
    'net_commission_cents', coalesce(
      (select sum(commission_cents) from public.commission_entries
       where created_at >= v_ts_start and created_at < v_ts_end), 0)
      - coalesce(
      (select sum(commission_cents) from public.commission_entries
       where status = 'reversed' and reversed_at >= v_ts_start and reversed_at < v_ts_end), 0),

    -- Approved and ready for payout (created this period)
    'approved_payable_cents', coalesce(
      (select sum(commission_cents) from public.commission_entries
       where status = 'approved' and created_at >= v_ts_start and created_at < v_ts_end), 0),

    -- Held (tax or suspension) — not payable this period
    'held_cents', coalesce(
      (select sum(commission_cents) from public.commission_entries
       where status = 'held' and created_at >= v_ts_start and created_at < v_ts_end), 0),

    -- Consultant-level accruals and reversals (for invoice line items)
    'by_consultant_accrued',   v_commission_accrued,
    'by_consultant_reversals', v_commission_reversed
  ) into v_commission_totals;

  -- ── Assemble and return final result ─────────────────────────────────────
  return jsonb_build_object(
    'year_month',    p_year_month,
    'period_start',  v_period_start::text,
    'period_end',    v_period_end::text,
    'revenue',       v_revenue_section,
    'commissions',   v_commission_totals
  );

end;
$$;

grant execute on function public.calculate_gross_month(text)
  to service_role;

comment on function public.calculate_gross_month(text) is
  'Monthly gross/net financial calculation for the invoice engine. '
  'Returns revenue (sales, returns, net) by license_body and commissions '
  '(accrued, reversals, net, payable, held) by consultant and in total. '
  'Uses occurred_at for ledger events, created_at for commission accruals, '
  'and reversed_at for reversal attribution. '
  'Net commission may be negative if reversals exceed new accruals for the period. '
  'Read-only — no writes. Called by the calculate-gross Edge Function (3E-2).';
