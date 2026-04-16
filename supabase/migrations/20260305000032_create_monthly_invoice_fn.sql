-- =============================================================================
-- Migration: 20260305000032_create_monthly_invoice_fn
--
-- Creates:
--   function public.create_monthly_invoice   persist the compiled monthly invoice
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Atomically inserts a monthly_invoices row from the pre-computed financial
-- data assembled by the 3E-4 pipeline (compile step). The Edge Function
-- runs calculate_gross_month and calculate_royalties_month in parallel,
-- derives the summary block, then calls this function to persist the record.
--
-- ─── Idempotency ─────────────────────────────────────────────────────────────
--
-- The (period_start, period_end) unique constraint makes a second call for
-- the same month a unique_violation. The function catches this exception,
-- fetches the existing record's id and status, and returns was_created = false.
--
-- This matters for the invoice engine's retry safety: if the Edge Function
-- times out or is retried after a successful DB write, it will not fail with
-- a 500 — it will return the existing invoice id with was_created = false.
--
-- ─── No overwrites ───────────────────────────────────────────────────────────
--
-- Idempotency returns the existing record — it does NOT update it. If a draft
-- invoice needs to be regenerated (e.g. after a ledger correction), the caller
-- must void the existing invoice first. This is an intentional safeguard:
-- financial records should not be silently overwritten.
--
-- ─── Input ───────────────────────────────────────────────────────────────────
--
-- All financial figures are passed in from the Edge Function. The DB function
-- does not re-query the ledger — it trusts the pre-computed values. This keeps
-- the function fast and its responsibility single: persist, not compute.
--
-- ─── Scalar + snapshot strategy ──────────────────────────────────────────────
--
-- Scalar columns (e.g. net_sales_cents, approved_payable_cents) are stored
-- for fast SQL reporting. JSONB snapshots are stored for full detail display.
-- Both are passed as parameters — they are logically consistent at the call
-- site (the Edge Function derives scalars from the same data as snapshots).
-- =============================================================================

create or replace function public.create_monthly_invoice(
  -- Period identification
  p_year_month                       text,        -- 'YYYY-MM'
  p_period_start                     date,
  p_period_end                       date,

  -- Revenue scalars
  p_gross_sales_cents                bigint,
  p_returns_cents                    bigint,
  p_net_sales_cents                  bigint,

  -- Commission scalars
  p_gross_accrued_cents              bigint,
  p_reversals_this_period_cents      bigint,
  p_net_commission_cents             bigint,
  p_approved_payable_cents           bigint,
  p_held_cents                       bigint,

  -- Royalty scalar
  p_total_royalties_remittance_cents bigint,

  -- Derived platform position
  p_net_platform_cents               bigint,

  -- Full JSONB snapshots
  p_revenue_snapshot                 jsonb,
  p_commissions_snapshot             jsonb,
  p_royalties_snapshot               jsonb,

  -- Audit
  p_created_by                       uuid
)
returns table (
  invoice_id   uuid,
  was_created  boolean,
  status       public.invoice_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id  uuid;
begin

  -- ── Validate period ────────────────────────────────────────────────────────
  if p_period_end < p_period_start then
    raise exception
      '[GTG] create_monthly_invoice: period_end (%) must be >= period_start (%).',
      p_period_end, p_period_start;
  end if;

  if p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception
      '[GTG] create_monthly_invoice: invalid year_month ''%''. Expected YYYY-MM.',
      p_year_month;
  end if;

  -- ── Validate non-negative aggregates ──────────────────────────────────────
  if p_gross_sales_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: gross_sales_cents must be >= 0, got %.',
      p_gross_sales_cents;
  end if;

  if p_returns_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: returns_cents must be >= 0, got %.',
      p_returns_cents;
  end if;

  if p_gross_accrued_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: gross_accrued_cents must be >= 0, got %.',
      p_gross_accrued_cents;
  end if;

  if p_reversals_this_period_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: reversals_this_period_cents must be >= 0, got %.',
      p_reversals_this_period_cents;
  end if;

  if p_approved_payable_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: approved_payable_cents must be >= 0, got %.',
      p_approved_payable_cents;
  end if;

  if p_held_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: held_cents must be >= 0, got %.',
      p_held_cents;
  end if;

  if p_total_royalties_remittance_cents < 0 then
    raise exception
      '[GTG] create_monthly_invoice: total_royalties_remittance_cents must be >= 0, got %.',
      p_total_royalties_remittance_cents;
  end if;

  -- ── Insert ─────────────────────────────────────────────────────────────────
  begin
    insert into public.monthly_invoices (
      year_month,
      period_start,
      period_end,
      gross_sales_cents,
      returns_cents,
      net_sales_cents,
      gross_accrued_cents,
      reversals_this_period_cents,
      net_commission_cents,
      approved_payable_cents,
      held_cents,
      total_royalties_remittance_cents,
      net_platform_cents,
      revenue_snapshot,
      commissions_snapshot,
      royalties_snapshot,
      status,
      created_by
    )
    values (
      p_year_month,
      p_period_start,
      p_period_end,
      p_gross_sales_cents,
      p_returns_cents,
      p_net_sales_cents,
      p_gross_accrued_cents,
      p_reversals_this_period_cents,
      p_net_commission_cents,
      p_approved_payable_cents,
      p_held_cents,
      p_total_royalties_remittance_cents,
      p_net_platform_cents,
      p_revenue_snapshot,
      p_commissions_snapshot,
      p_royalties_snapshot,
      'draft',
      p_created_by
    )
    returning id into v_invoice_id;

    return query select v_invoice_id, true, 'draft'::public.invoice_status;

  exception when unique_violation then
    -- ── Idempotency: invoice already exists for this period ──────────────────
    -- Fetch the existing record and return was_created = false.
    -- The caller decides whether to proceed (status = 'draft') or surface
    -- the existing id to the user.
    select mi.id, mi.status
    into v_invoice_id, create_monthly_invoice.status
    from public.monthly_invoices mi
    where mi.period_start = p_period_start
      and mi.period_end   = p_period_end;

    return query select v_invoice_id, false, create_monthly_invoice.status;
  end;

end;
$$;

grant execute on function public.create_monthly_invoice(
  text, date, date,
  bigint, bigint, bigint,
  bigint, bigint, bigint, bigint, bigint,
  bigint, bigint,
  jsonb, jsonb, jsonb,
  uuid
) to service_role;

comment on function public.create_monthly_invoice(
  text, date, date,
  bigint, bigint, bigint,
  bigint, bigint, bigint, bigint, bigint,
  bigint, bigint,
  jsonb, jsonb, jsonb,
  uuid
) is
  'Persists the compiled monthly financial statement as a monthly_invoices row. '
  'Accepts pre-computed scalar aggregates and full JSONB snapshots from the '
  'generate-invoice-record Edge Function (3E-4). '
  'Idempotent on (period_start, period_end): a second call for the same month '
  'returns was_created = false with the existing invoice_id — it does NOT '
  'overwrite the existing record. Regeneration requires voiding first. '
  'Write-only — no ledger re-queries. Called by generate-invoice-record (3E-4).';
