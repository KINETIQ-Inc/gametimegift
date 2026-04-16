-- =============================================================================
-- Migration: 20260305000030_calculate_royalties_month_fn
--
-- Creates:
--   function public.calculate_royalties_month   per-licensor monthly royalty calc
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Calculates the royalty obligation for every royalty-bearing license body
-- (CLC and ARMY) for a given calendar month in a single round-trip. This is
-- the monthly invoice engine's royalty step — the equivalent of running
-- calculate-royalty (3C-2) for each licensor simultaneously.
--
-- ─── Royalty math ────────────────────────────────────────────────────────────
--
-- Matches calculate-royalty (3C-2) exactly:
--
--   Per unit:    unit_royalty_cents = ROUND(retail_price_cents × royalty_rate)
--   Period total: royalty_cents = Σ unit_royalty_cents (integer sum of rounded units)
--   Floor:       remittance_cents = GREATEST(royalty_cents, minimum_royalty_cents ?? 0)
--
-- Rounding is applied per unit before summing, not to the aggregate. This
-- prevents floating-point drift across large unit volumes.
--
-- ─── Rate groups ─────────────────────────────────────────────────────────────
--
-- Units are grouped by their stamped royalty_rate for audit visibility.
-- Most months will have a single rate group per licensor. Multiple groups
-- arise when the license agreement rate changed during the month — each
-- group's ledger_entry_ids provide the full audit chain.
--
-- has_rate_mismatch = true when any unit's stamped rate differs from the
-- license holder's current default_royalty_rate (historical rate, not fraud).
--
-- ─── Idempotency signal ───────────────────────────────────────────────────────
--
-- existing_entry_id is populated if a royalty_entries row already exists for
-- (license_holder_id, period_start, period_end). The invoice engine uses this
-- to avoid attempting a duplicate insert (insert-royalty-entry is idempotent,
-- but the signal is useful for surfacing the condition upstream).
--
-- ─── Active-holder assumption ────────────────────────────────────────────────
--
-- Only active (is_active = true) license_holders are returned. If no active
-- holder exists for a body, that body is absent from the result. The invoice
-- engine treats an absent body as "no royalty obligation" for the period —
-- the same behaviour as calculate-royalty (3C-2) returning 404.
-- =============================================================================

create or replace function public.calculate_royalties_month(
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
  v_ts_end        timestamptz;
  v_royalties     jsonb;
begin

  -- ── Parse and validate year_month ─────────────────────────────────────────
  begin
    v_period_start := (p_year_month || '-01')::date;
  exception when others then
    raise exception
      '[GTG] calculate_royalties_month: invalid year_month ''%''. Expected YYYY-MM (e.g. ''2026-03'').',
      p_year_month;
  end;

  v_period_end := (date_trunc('month', v_period_start) + interval '1 month - 1 day')::date;
  v_ts_start   := v_period_start::timestamptz;
  v_ts_end     := v_period_end::timestamptz + interval '1 day';  -- exclusive

  -- ── CTE pipeline ─────────────────────────────────────────────────────────
  -- holders       → active license_holders for CLC and ARMY
  -- sold          → sold ledger entries with per-unit royalty (rounded)
  -- body_totals   → aggregate by license_body
  -- rate_groups   → group by (license_body, royalty_rate) for audit trail
  -- rate_groups_j → JSONB arrays per license_body
  -- existing      → existing royalty_entries for this period (idempotency signal)
  with
  holders as (
    select
      id,
      license_body,
      legal_name,
      code,
      default_royalty_rate,
      minimum_royalty_cents,
      reporting_period
    from public.license_holders
    where license_body in ('CLC', 'ARMY')
      and is_active = true
  ),

  sold as (
    select
      license_body,
      id                                                              as ledger_id,
      royalty_rate,
      retail_price_cents,
      -- Per-unit rounding: matches Math.round() in TypeScript calculate-royalty
      round(retail_price_cents::numeric * royalty_rate)::bigint      as unit_royalty_cents
    from public.inventory_ledger_entries
    where action       = 'sold'
      and occurred_at >= v_ts_start
      and occurred_at <  v_ts_end
      and license_body in ('CLC', 'ARMY')
  ),

  body_totals as (
    select
      license_body,
      count(*)                                      as units_sold,
      coalesce(sum(retail_price_cents), 0)          as gross_sales_cents,
      coalesce(sum(unit_royalty_cents), 0)          as royalty_cents,
      array_agg(ledger_id order by ledger_id)       as ledger_entry_ids
    from sold
    group by license_body
  ),

  rate_groups as (
    select
      license_body,
      royalty_rate,
      count(*)                                      as unit_count,
      coalesce(sum(retail_price_cents), 0)          as gross_sales_cents,
      coalesce(sum(unit_royalty_cents), 0)          as royalty_cents
    from sold
    group by license_body, royalty_rate
  ),

  rate_groups_j as (
    select
      license_body,
      jsonb_agg(
        jsonb_build_object(
          'royalty_rate',      royalty_rate,
          'unit_count',        unit_count,
          'gross_sales_cents', gross_sales_cents,
          'royalty_cents',     royalty_cents
        ) order by unit_count desc
      ) as groups
    from rate_groups
    group by license_body
  ),

  existing as (
    select license_body, id as existing_entry_id
    from public.royalty_entries
    where period_start  = v_period_start
      and period_end    = v_period_end
      and license_body in ('CLC', 'ARMY')
  )

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'license_body',          h.license_body,
        'license_holder_id',     h.id,
        'license_holder_name',   h.legal_name,
        'license_holder_code',   h.code,
        'reporting_period',      h.reporting_period,
        'default_royalty_rate',  h.default_royalty_rate,
        'minimum_royalty_cents', h.minimum_royalty_cents,

        -- Sales aggregates (0 when no sales in period)
        'units_sold',            coalesce(bt.units_sold, 0),
        'gross_sales_cents',     coalesce(bt.gross_sales_cents, 0),

        -- Royalty calculation (per-unit-rounded sum)
        'royalty_cents',         coalesce(bt.royalty_cents, 0),

        -- Minimum floor: GREATEST(royalty_cents, minimum ?? 0)
        'remittance_cents',      greatest(
                                   coalesce(bt.royalty_cents, 0),
                                   coalesce(h.minimum_royalty_cents, 0)
                                 ),
        'minimum_applied',       coalesce(bt.royalty_cents, 0)
                                   < coalesce(h.minimum_royalty_cents, 0),

        -- Rate mismatch: any unit stamped at a rate != current default
        -- (historical rate change, not fraud — informational for audit)
        'has_rate_mismatch',     exists(
                                   select 1 from rate_groups rg
                                   where rg.license_body = h.license_body
                                     and rg.royalty_rate != h.default_royalty_rate
                                 ),

        -- Rate groups for audit trail
        'rate_groups',           coalesce(rg.groups, '[]'::jsonb),

        -- Ledger entry IDs for royalty_entries.ledger_entry_ids
        'ledger_entry_ids',      coalesce(to_jsonb(bt.ledger_entry_ids), '[]'::jsonb),

        -- Existing royalty_entry for this period (null = safe to insert)
        'existing_entry_id',     ex.existing_entry_id
      )
      order by h.license_body
    ),
    '[]'::jsonb
  )
  into v_royalties
  from holders h
  left join body_totals   bt on bt.license_body = h.license_body
  left join rate_groups_j rg on rg.license_body = h.license_body
  left join existing      ex on ex.license_body = h.license_body;

  return jsonb_build_object(
    'year_month',    p_year_month,
    'period_start',  v_period_start::text,
    'period_end',    v_period_end::text,
    'royalties',     v_royalties
  );

end;
$$;

grant execute on function public.calculate_royalties_month(text)
  to service_role;

comment on function public.calculate_royalties_month(text) is
  'Per-licensor monthly royalty calculation for CLC and ARMY. '
  'Accepts YYYY-MM, derives period boundaries, and returns a JSONB array of '
  'royalty obligations — one entry per active license_holder. '
  'Royalty math matches calculate-royalty (3C-2): per-unit ROUND then sum, '
  'GREATEST(royalty_cents, minimum_royalty_cents) for the floor. '
  'Includes rate_groups for audit visibility and existing_entry_id as an '
  'idempotency signal for the downstream insert step. '
  'Read-only — no writes. Called by calculate-royalties-owed (3E-3) and '
  'compile-monthly-invoice (3E-4).';
