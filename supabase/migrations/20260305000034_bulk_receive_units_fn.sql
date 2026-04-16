-- =============================================================================
-- Migration: 20260305000034_bulk_receive_units_fn
--
-- Creates:
--   function public.bulk_receive_units   atomic batch + unit ingestion
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Receives a shipment of serialized units into inventory in a single atomic
-- transaction:
--
--   1. Validates the product is active and resolves the royalty_rate to stamp.
--   2. Creates the manufacturing_batch record.
--   3. Bulk-inserts all serialized_units with ON CONFLICT DO NOTHING —
--      serial numbers already in the DB are silently skipped.
--   4. Updates manufacturing_batches.received_unit_count with the actual count
--      of new rows inserted (excluding skipped conflicts).
--   5. Returns a summary: batch metadata, received count, and an array of
--      conflict serial numbers (those that already existed in the DB).
--
-- ─── Atomicity guarantee ─────────────────────────────────────────────────────
--
-- All steps run in one PL/pgSQL block (one transaction). A failure at any
-- step rolls back the entire operation — the batch is never left in an
-- orphaned state with a subset of its units committed.
--
-- ─── Serial number conflicts ─────────────────────────────────────────────────
--
-- ON CONFLICT DO NOTHING on serial_number means a duplicate serial does not
-- raise an error — the duplicate row is silently skipped. This is intentional:
-- a partial upload followed by a retry should not fail. The conflict serials
-- are collected and returned so the admin can investigate and log them.
--
-- ─── Royalty rate resolution ─────────────────────────────────────────────────
--
-- The rate stamped onto each unit is resolved once for the entire batch:
--   - product.royalty_rate (override) if not null
--   - active license_holder.default_royalty_rate for the product's license_body
--   - If license_body = 'NONE': royalty_rate is not applicable. A nominal value
--     of 0.0001 (0.01%) is used as a placeholder to satisfy the NOT NULL and
--     > 0 constraint. Units with license_body = 'NONE' are never included in
--     royalty calculations (filtered by license_body).
--
-- ─── Over-shipment guard ─────────────────────────────────────────────────────
--
-- manufacturing_batches.received_not_excess constraint enforces:
--   received_unit_count <= ceil(expected_unit_count * 1.1)
--
-- The Edge Function pre-validates this before calling the function. The DB
-- constraint provides the final safety net and raises a clear PG error if
-- the check fires.
-- =============================================================================

create or replace function public.bulk_receive_units(
  p_batch_number          text,
  p_product_id            uuid,
  p_expected_unit_count   integer,
  p_purchase_order_number text    default null,
  p_notes                 text    default null,
  p_serial_numbers        text[], -- array of serial_number strings from the CSV
  p_received_by           uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product             record;
  v_holder_rate         numeric(5,4);
  v_royalty_rate        numeric(5,4);
  v_batch_id            uuid;
  v_inserted_serials    text[];
  v_conflict_serials    text[];
  v_received_count      integer;
begin

  -- ── Validate input array ──────────────────────────────────────────────────
  if p_serial_numbers is null or array_length(p_serial_numbers, 1) is null then
    raise exception
      '[GTG] bulk_receive_units: p_serial_numbers must be a non-empty array.';
  end if;

  -- Check for empty or over-length entries within the array
  if exists (
    select 1 from unnest(p_serial_numbers) sn
    where trim(sn) = '' or length(sn) > 100
  ) then
    raise exception
      '[GTG] bulk_receive_units: p_serial_numbers contains invalid entries. '
      'Each serial number must be 1–100 non-whitespace characters.';
  end if;

  -- ── Fetch and validate product ────────────────────────────────────────────
  select
    id,
    sku,
    name        as product_name,
    license_body,
    royalty_rate,
    cost_cents,
    is_active
  into v_product
  from public.products
  where id = p_product_id;

  if not found then
    raise exception
      '[GTG] bulk_receive_units: product ''%'' not found.',
      p_product_id;
  end if;

  if not v_product.is_active then
    raise exception
      '[GTG] bulk_receive_units: product ''%'' (SKU: ''%'') is inactive. '
      'Reactivate the product before receiving new units.',
      p_product_id, v_product.sku;
  end if;

  -- ── Resolve royalty_rate to stamp onto units ──────────────────────────────
  if v_product.royalty_rate is not null then
    -- Product-level override takes precedence
    v_royalty_rate := v_product.royalty_rate;

  elsif v_product.license_body != 'NONE' then
    -- Inherit from active license_holder for this body
    select default_royalty_rate
    into v_holder_rate
    from public.license_holders
    where license_body = v_product.license_body
      and is_active    = true;

    if not found then
      raise exception
        '[GTG] bulk_receive_units: no active license_holder for license_body ''%''. '
        'Create an active license_holder record before receiving units for this product.',
        v_product.license_body;
    end if;

    v_royalty_rate := v_holder_rate;

  else
    -- license_body = 'NONE': no royalty obligation.
    -- Use nominal placeholder (0.0001) to satisfy NOT NULL and > 0 constraint.
    -- These units are excluded from all royalty calculations by license_body filter.
    v_royalty_rate := 0.0001;
  end if;

  -- ── Create manufacturing batch ────────────────────────────────────────────
  insert into public.manufacturing_batches (
    batch_number,
    product_id,
    sku,
    license_body,
    expected_unit_count,
    received_unit_count,
    purchase_order_number,
    notes,
    received_by
  )
  values (
    p_batch_number,
    p_product_id,
    v_product.sku,
    v_product.license_body,
    p_expected_unit_count,
    0,                          -- updated after unit insert
    p_purchase_order_number,
    p_notes,
    p_received_by
  )
  returning id into v_batch_id;

  -- ── Bulk insert units, skip conflicts ─────────────────────────────────────
  -- ON CONFLICT DO NOTHING silently skips any serial_number already in the DB.
  -- RETURNING captures only the rows that were actually inserted.
  with ins as (
    insert into public.serialized_units (
      serial_number,
      sku,
      product_id,
      product_name,
      status,
      license_body,
      royalty_rate,
      cost_cents,
      batch_id
    )
    select
      trim(sn),
      v_product.sku,
      p_product_id,
      v_product.product_name,
      'available',
      v_product.license_body,
      v_royalty_rate,
      v_product.cost_cents,
      v_batch_id
    from unnest(p_serial_numbers) as sn
    on conflict (serial_number) do nothing
    returning serial_number
  )
  select array_agg(serial_number)
  into v_inserted_serials
  from ins;

  -- Normalize null (no rows inserted) to empty array
  v_inserted_serials := coalesce(v_inserted_serials, array[]::text[]);
  v_received_count   := array_length(v_inserted_serials, 1);
  -- array_length returns null for empty array
  v_received_count   := coalesce(v_received_count, 0);

  -- ── Identify conflict serials ─────────────────────────────────────────────
  -- Conflict = in the input array but NOT in the inserted set.
  select array_agg(sn order by sn)
  into v_conflict_serials
  from unnest(p_serial_numbers) as sn
  where trim(sn) != all(v_inserted_serials);

  v_conflict_serials := coalesce(v_conflict_serials, array[]::text[]);

  -- ── Update batch received count ───────────────────────────────────────────
  -- This fires the received_not_excess constraint check:
  --   received_unit_count <= ceil(expected_unit_count * 1.1)
  -- If the actual received count exceeds the tolerance, PG raises the
  -- constraint violation. The entire transaction rolls back.
  update public.manufacturing_batches
  set received_unit_count = v_received_count
  where id = v_batch_id;

  -- ── Return summary ────────────────────────────────────────────────────────
  return jsonb_build_object(
    'batch_id',            v_batch_id,
    'batch_number',        p_batch_number,
    'product_id',          p_product_id,
    'sku',                 v_product.sku,
    'license_body',        v_product.license_body,
    'royalty_rate_stamped', v_royalty_rate,
    'expected_unit_count', p_expected_unit_count,
    'submitted_count',     array_length(p_serial_numbers, 1),
    'received_count',      v_received_count,
    'conflict_count',      array_length(v_conflict_serials, 1),
    'conflict_serials',    to_jsonb(v_conflict_serials)
  );

end;
$$;

grant execute on function public.bulk_receive_units(
  text, uuid, integer, text, text, text[], uuid
) to service_role;

comment on function public.bulk_receive_units(
  text, uuid, integer, text, text, text[], uuid
) is
  'Atomically receives a shipment of serialized units: creates the manufacturing '
  'batch, bulk-inserts all units (ON CONFLICT DO NOTHING for duplicates), and '
  'updates the batch received_unit_count. All steps run in one transaction. '
  'Returns { batch_id, received_count, conflict_count, conflict_serials[] }. '
  'Called by bulk-upload-units (4B-1).';
