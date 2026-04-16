-- =============================================================================
-- Migration: 20260305000022_create_commission_entry_fn
--
-- Creates:
--   function public.create_commission_entry(...)
--
-- Purpose:
--   Atomically creates one commission_entries row and links it back to its
--   order_lines row (order_lines.commission_entry_id). Both writes happen in
--   a single transaction to prevent the order line and commission entry from
--   becoming detached under concurrent writes or failures.
--
-- Idempotency:
--   If an active commission entry already exists for the given unit_id
--   (i.e. a row with status NOT IN ('reversed', 'voided') — enforced by the
--   partial unique index commission_entries_unit_id_active_unique_idx from
--   migration 16), the function returns the existing entry without inserting
--   a duplicate. was_created = false signals to the caller that the operation
--   was a no-op for this unit. This makes the insert-commission-entries Edge
--   Function safely retriable — re-sending after a network timeout will not
--   double-count commissions.
--
-- Concurrency:
--   The idempotency check uses an INSERT ... / EXCEPTION WHEN unique_violation
--   block rather than a pre-flight SELECT, making the check-then-insert atomic
--   within the serializable snapshot. A concurrent call that wins the race
--   triggers the unique_violation handler in the losing call, which then
--   fetches and returns the winner's entry. No lost updates, no duplicates.
--
-- order_lines.commission_entry_id update:
--   The UPDATE is conditional — it only fires when a new entry is created
--   (was_created = true). If the entry already existed, the order line was
--   presumably already linked during the original insert; re-updating it to
--   the same value is harmless but omitted to avoid a spurious updated_at
--   bump on the order line row.
--
-- Parameters:
--   p_consultant_id       uuid              — references consultant_profiles.id
--   p_consultant_name     text              — legal name at time of sale
--                                            (first + last, denormalized)
--   p_unit_id             uuid              — references serialized_units.id
--   p_order_id            uuid              — references orders.id
--   p_order_line_id       uuid              — references order_lines.id;
--                                            receives the commission_entry_id FK
--   p_serial_number       text              — denormalized from unit row
--   p_sku                 text              — denormalized from unit row
--   p_product_name        text              — denormalized from unit row
--   p_retail_price_cents  integer           — retail price at time of sale
--   p_commission_tier     commission_tier   — tier active at time of sale
--   p_commission_rate     numeric           — effective rate at time of sale
--   p_commission_cents    integer           — calculated amount to record
--   p_status              commission_status — 'earned' or 'held'
--   p_hold_reason         text | null       — required when p_status = 'held'
--
-- Returns: TABLE(commission_entry_id uuid, was_created boolean)
--   commission_entry_id — the newly inserted (or pre-existing) entry's id
--   was_created         — true if inserted now; false if idempotent no-op
-- =============================================================================

create or replace function public.create_commission_entry(
  p_consultant_id       uuid,
  p_consultant_name     text,
  p_unit_id             uuid,
  p_order_id            uuid,
  p_order_line_id       uuid,
  p_serial_number       text,
  p_sku                 text,
  p_product_name        text,
  p_retail_price_cents  integer,
  p_commission_tier     public.commission_tier,
  p_commission_rate     numeric,
  p_commission_cents    integer,
  p_status              public.commission_status,
  p_hold_reason         text  default null
)
returns table (
  commission_entry_id  uuid,
  was_created          boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id   uuid := gen_random_uuid();
  v_existing   uuid;
  v_now        timestamptz := now();
begin
  -- ── Application-layer pre-checks ─────────────────────────────────────────────
  -- Mirror constraints that have confusing DB error messages when violated.

  if p_status not in ('earned', 'held') then
    raise exception
      '[GTG] create_commission_entry: p_status must be ''earned'' or ''held'' at creation time '
      '(got ''%''). Transitions to approved/paid/reversed/voided are handled by '
      'separate update functions.',
      p_status;
  end if;

  if p_status = 'held' and (p_hold_reason is null or trim(p_hold_reason) = '') then
    raise exception
      '[GTG] create_commission_entry: p_hold_reason is required when p_status = ''held''. '
      'Document why the commission is being withheld (e.g. tax onboarding incomplete).';
  end if;

  if p_commission_rate <= 0 or p_commission_rate > 1 then
    raise exception
      '[GTG] create_commission_entry: p_commission_rate must be in (0, 1] (got %).',
      p_commission_rate;
  end if;

  if p_retail_price_cents <= 0 then
    raise exception
      '[GTG] create_commission_entry: p_retail_price_cents must be positive (got %).',
      p_retail_price_cents;
  end if;

  if p_commission_cents < 0 then
    raise exception
      '[GTG] create_commission_entry: p_commission_cents must be non-negative (got %).',
      p_commission_cents;
  end if;

  -- ── Atomic insert with idempotency via unique_violation handler ───────────────
  -- The partial unique index commission_entries_unit_id_active_unique_idx
  -- (migration 16) enforces at most one active entry per unit. Catching the
  -- unique_violation exception instead of a pre-flight SELECT makes the
  -- idempotency check atomic — no gap between check and insert.

  begin
    insert into public.commission_entries (
      id,
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
      status,
      hold_reason,
      created_at,
      updated_at
    ) values (
      v_entry_id,
      p_consultant_id,
      p_consultant_name,
      p_unit_id,
      p_order_id,
      p_serial_number,
      p_sku,
      p_product_name,
      p_retail_price_cents,
      p_commission_tier,
      p_commission_rate,
      p_commission_cents,
      p_status,
      p_hold_reason,
      v_now,
      v_now
    );

  exception
    when unique_violation then
      -- Another active commission entry exists for this unit.
      -- Fetch it and return as an idempotent no-op.
      select id
      into   v_existing
      from   public.commission_entries
      where  unit_id = p_unit_id
        and  status not in ('reversed', 'voided')
      limit  1;

      return query select v_existing, false;
      return;
  end;

  -- ── Link order line to the newly created entry ─────────────────────────────
  -- order_lines.commission_entry_id carries a FK to commission_entries (added
  -- as a deferred constraint in migration 9). Setting it here completes the
  -- bidirectional linkage: commission_entries.unit_id → unit, and
  -- order_lines.commission_entry_id → commission_entries.
  --
  -- Only executed on a fresh insert (idempotent path returns above).

  update public.order_lines
  set
    commission_entry_id = v_entry_id,
    updated_at          = v_now
  where id = p_order_line_id;

  if not found then
    raise exception
      '[GTG] create_commission_entry: order_line not found (id=%). '
      'Commission entry was inserted but the order line could not be linked.',
      p_order_line_id;
  end if;

  return query select v_entry_id, true;
end;
$$;

-- Grant to service_role for admin client RPC calls.
grant execute on function public.create_commission_entry(
  uuid, text, uuid, uuid, uuid,
  text, text, text,
  integer, public.commission_tier, numeric, integer,
  public.commission_status, text
) to service_role;

comment on function public.create_commission_entry(
  uuid, text, uuid, uuid, uuid,
  text, text, text,
  integer, public.commission_tier, numeric, integer,
  public.commission_status, text
) is
  'Atomically inserts a commission_entries row and links it to the corresponding '
  'order_lines.commission_entry_id. Idempotent: if an active entry already exists '
  'for the unit, returns the existing entry with was_created=false. '
  'Called by the insert-commission-entries Edge Function. '
  'Only ''earned'' and ''held'' are valid initial statuses.';
