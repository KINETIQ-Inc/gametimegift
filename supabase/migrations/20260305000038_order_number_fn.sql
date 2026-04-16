-- =============================================================================
-- Migration: 20260305000038_order_number_fn
--
-- Creates:
--   table public.order_number_counters      per-UTC-day atomic counter
--   function public.generate_order_number   produces GTG-YYYYMMDD-XXXXXX
--   function public.credit_consultant_sale  atomic running-total update
--
-- ─── Order number format ──────────────────────────────────────────────────────
--
--   GTG-YYYYMMDD-XXXXXX
--   Example: GTG-20260305-000001
--
--   - Date component is the UTC calendar date at generation time.
--   - XXXXXX is a zero-padded, monotonically increasing per-day counter.
--   - Counter resets at UTC midnight (each day starts at 000001).
--
-- ─── Atomicity guarantee ──────────────────────────────────────────────────────
--
--   generate_order_number uses INSERT ... ON CONFLICT DO UPDATE to atomically
--   increment the per-day counter. The upsert is atomic at the Postgres level —
--   two concurrent calls cannot produce the same counter value, even under
--   high concurrency. The UNIQUE constraint on orders.order_number provides a
--   second-line duplicate guard.
--
-- ─── credit_consultant_sale ───────────────────────────────────────────────────
--
--   Atomically increments lifetime_gross_sales_cents, lifetime_commissions_cents,
--   and pending_payout_cents on consultant_profiles, and records last_sale_at.
--   Must be called in the same sequence as commission_entries creation so the
--   running totals stay consistent with the ledger.
--
-- Callers:
--   stripe-webhook Edge Function via admin.rpc('generate_order_number')
--   stripe-webhook Edge Function via admin.rpc('credit_consultant_sale', {...})
-- =============================================================================


-- ─── Table: order_number_counters ─────────────────────────────────────────────

create table public.order_number_counters (
  -- UTC calendar date string in YYYYMMDD format.
  date_str  text     not null,

  -- Current sequential counter for this day.
  -- Each call to generate_order_number atomically increments this value.
  -- The first order of a day sets counter = 1.
  counter   integer  not null,

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint order_number_counters_pkey
    primary key (date_str),

  constraint order_number_counters_date_format
    check (date_str ~ '^[0-9]{8}$'),

  constraint order_number_counters_counter_positive
    check (counter > 0)
);

comment on table public.order_number_counters is
  'Per-UTC-day atomic counter backing generate_order_number(). '
  'One row per calendar day; counter holds the last-issued sequence value. '
  'Rows accumulate indefinitely as a historical record of daily order volume.';

comment on column public.order_number_counters.counter is
  'Monotonically increasing sequence value for this UTC day. '
  'Incremented atomically by generate_order_number() via INSERT ... ON CONFLICT DO UPDATE. '
  'The counter for a day starts at 1 and never resets.';


-- ─── Function: generate_order_number ─────────────────────────────────────────

create or replace function public.generate_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   text;
  v_counter integer;
begin
  v_today := to_char(now() at time zone 'UTC', 'YYYYMMDD');

  -- Atomically get the next counter value for today.
  -- First call of the day: inserts (date_str, counter=1).
  -- Subsequent calls: increments counter by 1 and returns the new value.
  -- Concurrent calls are serialized by Postgres row locking on the upsert
  -- target — each caller receives a distinct counter value.

  insert into public.order_number_counters (date_str, counter)
  values (v_today, 1)
  on conflict (date_str) do update
    set counter = order_number_counters.counter + 1
  returning counter into v_counter;

  -- Format: GTG-YYYYMMDD-XXXXXX (six-digit zero-padded counter)
  return 'GTG-' || v_today || '-' || lpad(v_counter::text, 6, '0');
end;
$$;

-- order_number_counters is written only by generate_order_number (service_role).
-- Application code never reads or writes it directly.
grant execute on function public.generate_order_number()
  to service_role;

comment on function public.generate_order_number() is
  'Atomically generates the next order number for the current UTC calendar day. '
  'Format: GTG-YYYYMMDD-XXXXXX (six-digit zero-padded sequential counter per day). '
  'Uses INSERT ... ON CONFLICT DO UPDATE on order_number_counters to guarantee '
  'uniqueness under concurrent calls — no two calls receive the same value. '
  'Called by the stripe-webhook Edge Function before order creation.';


-- ─── Function: credit_consultant_sale ────────────────────────────────────────
--
-- Atomically increments a consultant's running totals when a sale is confirmed.
-- Must be called AFTER the commission_entry record has been created, so that the
-- running totals on the profile stay consistent with the commission ledger.
--
-- Parameters:
--   p_consultant_id     uuid    — consultant_profiles.id to credit
--   p_gross_sales_cents integer — retail_price_cents of the sold unit
--   p_commission_cents  integer — commission amount earned (≥ 0)
--
-- Effects on consultant_profiles:
--   lifetime_gross_sales_cents += p_gross_sales_cents
--   lifetime_commissions_cents += p_commission_cents
--   pending_payout_cents       += p_commission_cents
--   last_sale_at                = now()
--   updated_at                  = now()
--
-- Returns: void
--
-- Caller:
--   stripe-webhook Edge Function via admin.rpc('credit_consultant_sale', {...}).
-- =============================================================================

create or replace function public.credit_consultant_sale(
  p_consultant_id     uuid,
  p_gross_sales_cents integer,
  p_commission_cents  integer
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.consultant_profiles
  set
    lifetime_gross_sales_cents = lifetime_gross_sales_cents + p_gross_sales_cents,
    lifetime_commissions_cents = lifetime_commissions_cents + p_commission_cents,
    pending_payout_cents       = pending_payout_cents + p_commission_cents,
    last_sale_at               = now(),
    updated_at                 = now()
  where id = p_consultant_id;
$$;

grant execute on function public.credit_consultant_sale(uuid, integer, integer)
  to service_role;

comment on function public.credit_consultant_sale(uuid, integer, integer) is
  'Atomically increments lifetime_gross_sales_cents, lifetime_commissions_cents, '
  'and pending_payout_cents on a consultant_profiles row. Records last_sale_at. '
  'Must be called after the commission_entries row is created — the running totals '
  'on the profile must stay consistent with the commission ledger. '
  'Called by the stripe-webhook Edge Function after commission_entries creation.';


-- ─── Row Level Security ───────────────────────────────────────────────────────
-- order_number_counters is an internal bookkeeping table.
-- No application reads; no consultant or customer access needed.
alter table public.order_number_counters enable row level security;

-- Admin read-only for auditing daily order volume.
create policy "order_number_counters_select_admin"
  on public.order_number_counters
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- INSERT and UPDATE are performed only by generate_order_number (service_role).
-- No RLS policy is needed for service_role as it bypasses RLS entirely.
-- No DELETE policy — rows are permanent historical records.
