-- =============================================================================
-- Migration: 20260305000023_create_royalty_entry_fn
--
-- Creates:
--   function public.create_royalty_entry   idempotent royalty entry insert
-- =============================================================================

-- ─── Function: create_royalty_entry ──────────────────────────────────────────
-- Atomically inserts a royalty_entries row for a single reporting period.
--
-- Idempotency contract:
--   If a row already exists for (license_holder_id, period_start, period_end),
--   the unique_violation exception is caught and the existing entry is returned
--   with was_created = false. The caller may safely retry without duplicating.
--
-- Immutability contract:
--   Entries are inserted at status = 'calculated'. Amendments after submission
--   require a new entry or a status transition — not an UPDATE to an existing
--   calculated entry.
--
-- Active-holder guard:
--   Validates that the license_holder is still active at insert time. Protects
--   against the race where the holder is deactivated between the calculate-royalty
--   read and this insert. If deactivated, raises with a corrective-action message.

create or replace function public.create_royalty_entry(
  p_license_body          text,
  p_period_start          date,
  p_period_end            date,
  p_license_holder_id     uuid,
  p_license_holder_name   text,
  p_reporting_period      text,
  p_units_sold            integer,
  p_gross_sales_cents     integer,
  p_royalty_rate          numeric,
  p_royalty_cents         integer,
  p_remittance_cents      integer,
  p_minimum_applied       boolean,
  p_ledger_entry_ids      uuid[],
  p_created_by            uuid
)
returns table (
  royalty_entry_id  uuid,
  was_created       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id   uuid;
  v_existing   uuid;
begin

  -- ── Validate period window ─────────────────────────────────────────────────
  if p_period_end < p_period_start then
    raise exception '[GTG] create_royalty_entry: period_end must be >= period_start.';
  end if;

  -- ── Validate rate ──────────────────────────────────────────────────────────
  if p_royalty_rate <= 0 or p_royalty_rate > 1 then
    raise exception '[GTG] create_royalty_entry: royalty_rate must be > 0 and <= 1, got %.', p_royalty_rate;
  end if;

  -- ── Validate remittance floor ──────────────────────────────────────────────
  -- remittance_cents = max(royalty_cents, minimum_floor). Must never be less.
  if p_remittance_cents < p_royalty_cents then
    raise exception '[GTG] create_royalty_entry: remittance_cents (%) must be >= royalty_cents (%).',
      p_remittance_cents, p_royalty_cents;
  end if;

  -- ── Validate units_sold ────────────────────────────────────────────────────
  -- Table constraint also enforces this, but raising here gives a cleaner message.
  if p_units_sold <= 0 then
    raise exception '[GTG] create_royalty_entry: units_sold must be > 0. '
      'Zero-sale periods do not produce a royalty entry.';
  end if;

  -- ── Active-holder guard ────────────────────────────────────────────────────
  -- Re-verify the holder is still active. Guards against the race where the
  -- holder was deactivated between calculate-royalty and this insert.
  if not exists (
    select 1
    from   public.license_holders
    where  id        = p_license_holder_id
      and  is_active = true
  ) then
    raise exception '[GTG] create_royalty_entry: license_holder % is no longer active. '
      'Re-run calculate-royalty to resolve the current active holder before retrying.',
      p_license_holder_id;
  end if;

  -- ── Insert (idempotent) ────────────────────────────────────────────────────
  begin
    insert into public.royalty_entries (
      license_holder_id,
      license_body,
      license_holder_name,
      reporting_period,
      period_start,
      period_end,
      ledger_entry_ids,
      units_sold,
      gross_sales_cents,
      royalty_rate,
      royalty_cents,
      remittance_cents,
      minimum_applied,
      status,
      created_by
    ) values (
      p_license_holder_id,
      p_license_body::public.license_body,
      p_license_holder_name,
      p_reporting_period::public.reporting_period,
      p_period_start,
      p_period_end,
      p_ledger_entry_ids,
      p_units_sold,
      p_gross_sales_cents,
      p_royalty_rate,
      p_royalty_cents,
      p_remittance_cents,
      p_minimum_applied,
      'calculated',
      p_created_by
    )
    returning id into v_entry_id;

    return query select v_entry_id, true;

  exception when unique_violation then
    -- Entry already exists for this license_holder + period.
    -- Idempotent re-insert: fetch and return the existing entry.
    select id into v_existing
    from   public.royalty_entries
    where  license_holder_id = p_license_holder_id
      and  period_start      = p_period_start
      and  period_end        = p_period_end;

    return query select v_existing, false;
  end;

end;
$$;

-- Service role is used by the admin client in Edge Functions.
grant execute on function public.create_royalty_entry(
  text, date, date, uuid, text, text, integer, integer, numeric, integer, integer, boolean, uuid[], uuid
) to service_role;

comment on function public.create_royalty_entry is
  'Atomically inserts a royalty_entries row for one license body and reporting period. '
  'Idempotent: if a row already exists for (license_holder_id, period_start, period_end), '
  'returns the existing entry with was_created = false. Status is always ''calculated'' '
  'on creation. Validates the license_holder is active at insert time.';
