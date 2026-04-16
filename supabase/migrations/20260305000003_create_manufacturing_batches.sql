-- =============================================================================
-- Migration: 20260305000003_create_manufacturing_batches
--
-- Creates:
--   table public.manufacturing_batches    physical receiving batch records
--   RLS   manufacturing_batches           admin read/write only
--   alter public.serialized_units         adds batch_id FK column
--
-- A manufacturing batch is a discrete receiving event: a shipment of
-- serialized units received from a supplier or licensor in one transaction.
-- Every unit received in the same delivery is assigned the same batch_id,
-- enabling shipment-level traceability for recalls, audits, and hologram
-- reconciliation.
-- =============================================================================

-- ─── Table: manufacturing_batches ────────────────────────────────────────────
-- Records a single receiving event (shipment / purchase order fulfillment).
-- Units received in this batch reference it via serialized_units.batch_id.
--
-- Compliance contract:
--   - batch_number is immutable after creation (enforced by trigger below).
--     It appears on physical receiving documents and is the stable reference
--     for supplier disputes, recall actions, and hologram audits.
--   - expected_unit_count records the supplier's declared quantity on the
--     shipping manifest. received_unit_count reflects what was actually
--     counted and entered into inventory; discrepancies trigger an investigation.
--   - Hard delete is prohibited.

create table public.manufacturing_batches (
  -- Identity
  id                    uuid          not null  default gen_random_uuid(),
  -- Immutable human-readable identifier. Format: uppercase alphanumeric, hyphens.
  -- Example: BATCH-20260305-CLC-001
  batch_number          text          not null,

  -- Product linkage (denormalized at receive time)
  product_id            uuid          not null  references public.products (id),
  -- Denormalized from products.sku at batch creation. Immutable.
  sku                   text          not null,
  -- Denormalized from products.license_body at batch creation.
  license_body          public.license_body  not null,

  -- Shipment details
  -- Declared quantity on the supplier's shipping manifest.
  expected_unit_count   integer       not null,
  -- Actual count of units entered into serialized_units for this batch.
  -- Starts at 0; incremented as units are registered.
  -- A batch is fully received when received_unit_count = expected_unit_count.
  received_unit_count   integer       not null  default 0,
  -- External purchase order reference (supplier's document number).
  purchase_order_number text,
  -- Free-text receiving notes: condition, carrier, discrepancies, etc.
  notes                 text,

  -- Audit
  received_by           uuid          not null  references auth.users (id),
  received_at           timestamptz   not null  default now(),
  created_at            timestamptz   not null  default now(),
  updated_at            timestamptz   not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint manufacturing_batches_pkey
    primary key (id),

  constraint manufacturing_batches_batch_number_unique
    unique (batch_number),

  -- Batch number format: uppercase letters, digits, hyphens.
  -- Must start with a letter or digit. Length 3–80 characters.
  constraint manufacturing_batches_batch_number_format
    check (batch_number ~ '^[A-Z0-9][A-Z0-9-]{2,79}$'),

  constraint manufacturing_batches_expected_positive
    check (expected_unit_count > 0),

  -- received_unit_count must be ≥ 0 and cannot exceed expected + 10%
  -- (small tolerance for mis-shipments; larger overages require investigation).
  constraint manufacturing_batches_received_count_nonneg
    check (received_unit_count >= 0),

  constraint manufacturing_batches_received_not_excess
    check (received_unit_count <= ceil(expected_unit_count * 1.1))
);

-- ─── Immutability Trigger ─────────────────────────────────────────────────────
-- batch_number is referenced on physical documents and supplier records.
-- Once created, it cannot be changed regardless of role.

create or replace function public.prevent_batch_number_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.batch_number is distinct from new.batch_number then
    raise exception
      '[GTG] Manufacturing batch_number is immutable. Cannot change ''%'' to ''%''. '
      'batch_number appears on physical receiving documents. Create a new batch instead.',
      old.batch_number, new.batch_number;
  end if;
  return new;
end;
$$;

create trigger manufacturing_batches_immutable_batch_number
  before update on public.manufacturing_batches
  for each row
  execute function public.prevent_batch_number_update();

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger manufacturing_batches_set_updated_at
  before update on public.manufacturing_batches
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unique constraint on batch_number already creates a B-tree index.

-- Product → batches: list all receiving history for a product.
create index manufacturing_batches_product_id_idx
  on public.manufacturing_batches (product_id);

-- License body: scope royalty audits to CLC or Army batches.
create index manufacturing_batches_license_body_idx
  on public.manufacturing_batches (license_body);

-- Receiving date: time-series queries for receiving volume reports.
create index manufacturing_batches_received_at_idx
  on public.manufacturing_batches (received_at desc);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.manufacturing_batches enable row level security;

-- SELECT: admins and licensor auditors may read batches.
-- Licensor auditors (CLC, Army) need batch records to reconcile shipment
-- quantities against royalty reports.
create policy "manufacturing_batches_select_admin"
  on public.manufacturing_batches
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Batches are created when a shipment is received.
create policy "manufacturing_batches_insert_admin"
  on public.manufacturing_batches
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Only received_unit_count, notes, and purchase_order_number
-- may change after creation; batch_number is blocked by trigger.
create policy "manufacturing_batches_update_admin"
  on public.manufacturing_batches
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: no policy defined. Hard deletes are permanently prohibited.

-- ─── Add batch_id to serialized_units ────────────────────────────────────────
-- Each serialized unit records which receiving batch it arrived in.
-- Nullable: units received before this migration existed, or imported units
-- without batch tracking, carry null.

alter table public.serialized_units
  add column batch_id uuid references public.manufacturing_batches (id);

-- Batch → units: list all units received in a batch.
-- This is the primary query for batch reconciliation and recall actions.
create index serialized_units_batch_id_idx
  on public.serialized_units (batch_id)
  where batch_id is not null;

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.manufacturing_batches is
  'A discrete receiving event: one shipment of serialized units from a supplier. '
  'All units in the same delivery share a batch_id. Provides shipment-level '
  'traceability for recalls, hologram audits, and royalty reconciliation.';

comment on column public.manufacturing_batches.batch_number is
  'Immutable human-readable batch identifier. Printed on receiving documents. '
  'Uppercase alphanumeric with hyphens, 3–80 chars. Cannot be changed after '
  'any unit references this batch.';

comment on column public.manufacturing_batches.expected_unit_count is
  'Unit count declared on the supplier''s shipping manifest. Used to detect '
  'short shipments or over-shipments at receiving time.';

comment on column public.manufacturing_batches.received_unit_count is
  'Actual count of units entered into serialized_units for this batch. '
  'Incremented as units are registered. Reaches expected_unit_count when the '
  'batch is fully received. Discrepancies are flagged for investigation.';

comment on column public.manufacturing_batches.purchase_order_number is
  'External purchase order reference from the supplier''s document. '
  'Optional but required for financial reconciliation when available.';

comment on column public.serialized_units.batch_id is
  'Manufacturing batch this unit arrived in. References manufacturing_batches.id. '
  'Null for units received before batch tracking was introduced or for '
  'individually imported units without a batch record.';
