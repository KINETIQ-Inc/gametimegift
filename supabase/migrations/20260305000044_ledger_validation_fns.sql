-- =============================================================================
-- Migration: 20260305000044_ledger_validation_fns
--
-- Creates a suite of ledger consistency validation functions (7C-2).
-- These functions are used by the load test validator
-- (load-tests/helpers/validate-ledger.js) and may be called in production
-- for scheduled consistency audits.
--
-- ─── Functions created ────────────────────────────────────────────────────────
--
--   validate_unit_ledger_status_match()
--     Units where serialized_units.status ≠ the to_status of their most
--     recent inventory_ledger_entry. Indicates a partial write: the unit row
--     was updated but the ledger entry was not written (or vice versa).
--
--   validate_sold_units_have_order_lines()
--     Units with status = 'sold' that have no non-cancelled order_line.
--     Indicates the sell_unit DB function completed but order_line creation
--     failed mid-transaction (should be impossible due to atomicity, but
--     verifies this under concurrent load).
--
--   validate_commission_entry_completeness()
--     Order lines on consultant_assisted orders (non-cancelled) whose
--     commission_entry_id is null. Indicates the commission_entry INSERT
--     succeeded but the order_line back-link write failed, or vice versa.
--
--   validate_consultant_running_totals()
--     Consultants where pending_payout_cents on the profile row ≠ the sum
--     of commission_entries.commission_cents WHERE status = 'earned'.
--     Running totals are incremented by credit_consultant_sale(); a mismatch
--     indicates a race condition or partial failure in that call path.
--
--   validate_lifetime_commission_totals()
--     Consultants where lifetime_commissions_cents < pending_payout_cents.
--     lifetime_commissions_cents is monotonically increasing and must always
--     be ≥ pending_payout_cents (pending is a subset of lifetime).
--
--   validate_order_financial_totals()
--     Orders where total_cents ≠ subtotal - discount + shipping + tax.
--     The check constraint enforces this at write time; this function confirms
--     no constraint was bypassed.
--
--   validate_payment_event_idempotency()
--     Duplicate stripe_event_id values in payment_events. The unique constraint
--     should prevent these; finding any indicates a constraint bypass.
--
--   validate_ledger_transition_chain()
--     Inventory ledger entries where the entry's from_status ≠ the previous
--     entry's to_status for the same unit. A break in the chain means a ledger
--     entry was written with an incorrect from_status.
--
--   validate_order_line_unit_coverage()
--     Sold units (status = 'sold') where the linked order_line references a
--     different unit_id than the unit itself. Cross-checks the unit→line
--     linkage from both sides.
--
--   run_ledger_consistency_checks()
--     Orchestrator. Calls all validation functions above and returns one row
--     per check with pass/fail status, violation count, and sample IDs.
--     The load test runner script calls only this function.
--
-- ─── Design notes ─────────────────────────────────────────────────────────────
--
-- All functions are SECURITY DEFINER (execute as the function owner, not the
-- caller) and grant only to service_role. They are never callable by
-- authenticated users or anon sessions — they expose full table scans across
-- all rows regardless of RLS.
--
-- Functions return TABLE results so violations can be inspected row-by-row
-- when debugging. run_ledger_consistency_checks() aggregates to summary rows
-- for the automated validator.
--
-- ─── Indexes relied upon ──────────────────────────────────────────────────────
--
-- validate_unit_ledger_status_match:
--   inventory_ledger_entries_unit_id_idx ON (unit_id, occurred_at DESC)
--   → drives the LATERAL subquery (last entry per unit).
--
-- validate_ledger_transition_chain:
--   Same index drives the window function partition + order.
--
-- validate_commission_entry_completeness:
--   commission_entries_order_id_idx ON commission_entries (order_id)
--   order_lines_order_id_idx ON order_lines (order_id)
-- =============================================================================


-- ─── 1. Unit ↔ Ledger status match ───────────────────────────────────────────

create or replace function public.validate_unit_ledger_status_match()
returns table (
  unit_id           uuid,
  serial_number     text,
  unit_status       public.unit_status,
  last_ledger_status public.unit_status
)
language sql
security definer
set search_path = public
as $$
  select
    su.id              as unit_id,
    su.serial_number,
    su.status          as unit_status,
    last_entry.to_status as last_ledger_status
  from public.serialized_units su
  cross join lateral (
    select to_status
    from public.inventory_ledger_entries
    where unit_id = su.id
    order by occurred_at desc
    limit 1
  ) last_entry
  where su.status != last_entry.to_status;
$$;

comment on function public.validate_unit_ledger_status_match() is
  'Returns units where serialized_units.status differs from the to_status of '
  'their most recent inventory_ledger_entry. Any row is a write-consistency violation.';


-- ─── 2. Sold units have order lines ──────────────────────────────────────────

create or replace function public.validate_sold_units_have_order_lines()
returns table (
  unit_id       uuid,
  serial_number text,
  order_id      uuid
)
language sql
security definer
set search_path = public
as $$
  select
    su.id            as unit_id,
    su.serial_number,
    su.order_id
  from public.serialized_units su
  where su.status = 'sold'
    and not exists (
      select 1
      from public.order_lines ol
      where ol.unit_id = su.id
        and ol.status != 'cancelled'
    );
$$;

comment on function public.validate_sold_units_have_order_lines() is
  'Returns units with status = ''sold'' that have no non-cancelled order_line. '
  'Every sold unit must have exactly one attributable order_line.';


-- ─── 3. Commission entry completeness ────────────────────────────────────────

create or replace function public.validate_commission_entry_completeness()
returns table (
  order_line_id  uuid,
  order_id       uuid,
  unit_id        uuid,
  serial_number  text,
  order_channel  public.fulfillment_channel
)
language sql
security definer
set search_path = public
as $$
  select
    ol.id           as order_line_id,
    ol.order_id,
    ol.unit_id,
    ol.serial_number,
    o.channel       as order_channel
  from public.order_lines ol
  join public.orders o on o.id = ol.order_id
  where o.channel  = 'consultant_assisted'
    and ol.status != 'cancelled'
    and ol.commission_entry_id is null;
$$;

comment on function public.validate_commission_entry_completeness() is
  'Returns consultant_assisted order lines (non-cancelled) with no commission_entry_id. '
  'Every such line must link to a commission_entry after payment is confirmed.';


-- ─── 4. Consultant pending payout totals ─────────────────────────────────────

create or replace function public.validate_consultant_running_totals()
returns table (
  consultant_id    uuid,
  display_name     text,
  profile_pending  integer,
  ledger_pending   bigint,
  discrepancy      bigint
)
language sql
security definer
set search_path = public
as $$
  select
    cp.id                                        as consultant_id,
    cp.display_name,
    cp.pending_payout_cents                      as profile_pending,
    coalesce(earned.total, 0)                    as ledger_pending,
    cp.pending_payout_cents - coalesce(earned.total, 0) as discrepancy
  from public.consultant_profiles cp
  left join (
    select
      consultant_id,
      sum(commission_cents) as total
    from public.commission_entries
    where status = 'earned'
    group by consultant_id
  ) earned on earned.consultant_id = cp.id
  where cp.pending_payout_cents != coalesce(earned.total, 0);
$$;

comment on function public.validate_consultant_running_totals() is
  'Returns consultants where pending_payout_cents on the profile does not equal '
  'the sum of earned commission_entries. Detects drift in the running-total counter.';


-- ─── 5. Lifetime ≥ pending invariant ─────────────────────────────────────────

create or replace function public.validate_lifetime_commission_totals()
returns table (
  consultant_id              uuid,
  display_name               text,
  lifetime_commissions_cents integer,
  pending_payout_cents       integer
)
language sql
security definer
set search_path = public
as $$
  select
    id,
    display_name,
    lifetime_commissions_cents,
    pending_payout_cents
  from public.consultant_profiles
  where lifetime_commissions_cents < pending_payout_cents;
$$;

comment on function public.validate_lifetime_commission_totals() is
  'Returns consultants where lifetime_commissions_cents < pending_payout_cents. '
  'Pending payouts are a subset of lifetime commissions; this invariant must hold.';


-- ─── 6. Order financial totals ────────────────────────────────────────────────

create or replace function public.validate_order_financial_totals()
returns table (
  order_id       uuid,
  order_number   text,
  total_cents    integer,
  computed_total integer,
  discrepancy    integer
)
language sql
security definer
set search_path = public
as $$
  select
    id                                                             as order_id,
    order_number,
    total_cents,
    (subtotal_cents - discount_cents + shipping_cents + tax_cents) as computed_total,
    total_cents - (subtotal_cents - discount_cents + shipping_cents + tax_cents) as discrepancy
  from public.orders
  where total_cents != (subtotal_cents - discount_cents + shipping_cents + tax_cents);
$$;

comment on function public.validate_order_financial_totals() is
  'Returns orders where total_cents ≠ subtotal - discount + shipping + tax. '
  'The check constraint enforces this at write time; any row here indicates a bypass.';


-- ─── 7. Payment event idempotency ────────────────────────────────────────────

create or replace function public.validate_payment_event_idempotency()
returns table (
  stripe_event_id text,
  occurrences     bigint
)
language sql
security definer
set search_path = public
as $$
  select
    stripe_event_id,
    count(*) as occurrences
  from public.payment_events
  where stripe_event_id is not null
  group by stripe_event_id
  having count(*) > 1;
$$;

comment on function public.validate_payment_event_idempotency() is
  'Returns Stripe event IDs that appear more than once in payment_events. '
  'The unique constraint prevents duplicates; any row here indicates a constraint bypass.';


-- ─── 8. Ledger transition chain integrity ─────────────────────────────────────

create or replace function public.validate_ledger_transition_chain()
returns table (
  entry_id       uuid,
  unit_id        uuid,
  serial_number  text,
  action         public.ledger_action,
  expected_from  public.unit_status,
  actual_from    public.unit_status,
  occurred_at    timestamptz
)
language sql
security definer
set search_path = public
as $$
  with ordered_entries as (
    select
      ile.id,
      ile.unit_id,
      ile.serial_number,
      ile.action,
      ile.from_status,
      ile.to_status,
      ile.occurred_at,
      lag(ile.to_status) over (
        partition by ile.unit_id
        order by ile.occurred_at asc, ile.id asc
      ) as prev_to_status
    from public.inventory_ledger_entries ile
  )
  select
    id            as entry_id,
    unit_id,
    serial_number,
    action,
    prev_to_status as expected_from,
    from_status    as actual_from,
    occurred_at
  from ordered_entries
  where prev_to_status is not null
    and from_status    is not null
    and from_status   != prev_to_status;
$$;

comment on function public.validate_ledger_transition_chain() is
  'Returns ledger entries where from_status ≠ the previous entry''s to_status for '
  'the same unit. A break in the chain indicates an entry was written with an '
  'incorrect from_status, or entries are out of chronological order.';


-- ─── 9. Order line ↔ unit cross-reference ────────────────────────────────────

create or replace function public.validate_order_line_unit_coverage()
returns table (
  order_line_id  uuid,
  order_id       uuid,
  line_unit_id   uuid,
  unit_order_id  uuid,
  serial_number  text
)
language sql
security definer
set search_path = public
as $$
  -- Order lines whose unit is marked sold but the unit's order_id
  -- does not match the line's order_id.
  select
    ol.id         as order_line_id,
    ol.order_id,
    ol.unit_id    as line_unit_id,
    su.order_id   as unit_order_id,
    ol.serial_number
  from public.order_lines ol
  join public.serialized_units su on su.id = ol.unit_id
  where ol.status  != 'cancelled'
    and su.status   = 'sold'
    and su.order_id != ol.order_id;
$$;

comment on function public.validate_order_line_unit_coverage() is
  'Returns order lines where the unit''s order_id (on serialized_units) does not '
  'match the line''s order_id. Indicates the unit was re-assigned to a different '
  'order without updating the order_line, or vice versa.';


-- ─── 10. Orchestrator: run all checks ────────────────────────────────────────

create or replace function public.run_ledger_consistency_checks()
returns table (
  check_name       text,
  pass             boolean,
  violation_count  bigint,
  -- Comma-separated sample IDs for rapid manual investigation.
  -- At most 5 IDs to keep the output human-readable.
  sample_ids       text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
  v_ids   text;
begin

  -- 1. Unit ↔ Ledger status match
  select
    count(*),
    string_agg(unit_id::text, ', ' order by unit_id limit 5)
  into v_count, v_ids
  from public.validate_unit_ledger_status_match();

  return query select
    'unit_ledger_status_match'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 2. Sold units have order lines
  select
    count(*),
    string_agg(unit_id::text, ', ' order by unit_id limit 5)
  into v_count, v_ids
  from public.validate_sold_units_have_order_lines();

  return query select
    'sold_units_have_order_lines'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 3. Commission entry completeness
  select
    count(*),
    string_agg(order_line_id::text, ', ' order by order_line_id limit 5)
  into v_count, v_ids
  from public.validate_commission_entry_completeness();

  return query select
    'commission_entry_completeness'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 4. Consultant running totals
  select
    count(*),
    string_agg(consultant_id::text, ', ' order by consultant_id limit 5)
  into v_count, v_ids
  from public.validate_consultant_running_totals();

  return query select
    'consultant_running_totals'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 5. Lifetime ≥ pending
  select
    count(*),
    string_agg(consultant_id::text, ', ' order by consultant_id limit 5)
  into v_count, v_ids
  from public.validate_lifetime_commission_totals();

  return query select
    'lifetime_gte_pending'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 6. Order financial totals
  select
    count(*),
    string_agg(order_id::text, ', ' order by order_id limit 5)
  into v_count, v_ids
  from public.validate_order_financial_totals();

  return query select
    'order_financial_totals'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 7. Payment event idempotency
  select
    count(*),
    string_agg(stripe_event_id, ', ' order by stripe_event_id limit 5)
  into v_count, v_ids
  from public.validate_payment_event_idempotency();

  return query select
    'payment_event_idempotency'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 8. Ledger transition chain
  select
    count(*),
    string_agg(entry_id::text, ', ' order by entry_id limit 5)
  into v_count, v_ids
  from public.validate_ledger_transition_chain();

  return query select
    'ledger_transition_chain'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

  -- 9. Order line ↔ unit cross-reference
  select
    count(*),
    string_agg(order_line_id::text, ', ' order by order_line_id limit 5)
  into v_count, v_ids
  from public.validate_order_line_unit_coverage();

  return query select
    'order_line_unit_coverage'::text,
    v_count = 0,
    v_count,
    coalesce(v_ids, '');

end;
$$;

comment on function public.run_ledger_consistency_checks() is
  'Orchestrates all ledger consistency validation functions and returns one row per '
  'check with pass/fail status, violation count, and up to 5 sample IDs for inspection. '
  'Called by load-tests/helpers/validate-ledger.js after load test runs. '
  'Safe to call in production for scheduled consistency audits.';


-- ─── Permissions ──────────────────────────────────────────────────────────────
-- All functions are service_role only — they perform full table scans
-- across all rows regardless of RLS. Never expose to authenticated users.

grant execute on function public.validate_unit_ledger_status_match()       to service_role;
grant execute on function public.validate_sold_units_have_order_lines()     to service_role;
grant execute on function public.validate_commission_entry_completeness()   to service_role;
grant execute on function public.validate_consultant_running_totals()       to service_role;
grant execute on function public.validate_lifetime_commission_totals()      to service_role;
grant execute on function public.validate_order_financial_totals()          to service_role;
grant execute on function public.validate_payment_event_idempotency()       to service_role;
grant execute on function public.validate_ledger_transition_chain()         to service_role;
grant execute on function public.validate_order_line_unit_coverage()        to service_role;
grant execute on function public.run_ledger_consistency_checks()            to service_role;
