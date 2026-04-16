-- =============================================================================
-- Migration: 20260305000008_create_inventory_ledger_entries
--
-- Creates:
--   type  public.ledger_action           enum for unit state-change events
--   table public.inventory_ledger_entries append-only audit log for units
--   RLS   inventory_ledger_entries        admin + auditor read; admin insert
-- =============================================================================

-- ─── Enum: ledger_action ──────────────────────────────────────────────────────
-- All actions that produce an immutable ledger entry.
-- One ledger entry is written for every state change on a serialized unit.
--
-- SYNC REQUIREMENT: values must match @gtg/types LedgerAction exactly.

create type public.ledger_action as enum (
  'received',             -- Unit entered inventory
  'hologram_applied',     -- Hologram affixed to the unit
  'reserved',             -- Unit held against an order
  'reservation_released', -- Hold cancelled (order voided or timed out)
  'sold',                 -- Ownership transferred; order_id populated
  'returned',             -- Customer return accepted
  'fraud_locked',         -- Fraud authority locked the unit
  'fraud_released',       -- Fraud lock lifted; unit restored to prior status
  'voided'                -- Unit destroyed or written off permanently
);

-- ─── Table: inventory_ledger_entries ─────────────────────────────────────────
-- Immutable audit log for every state change on a serialized unit.
-- The ledger is the source of truth for compliance reporting.
--
-- Append-only contract:
--   - No UPDATE or DELETE on this table. Ever.
--   - No updated_at column — this table does not change after insert.
--   - RLS has no UPDATE or DELETE policies.
--   - The TypeScript Database type defines Update: Record<string, never>
--     to produce a compile error on any attempted update.
--
-- Denormalization contract:
--   All fields are copied from the unit and context at event time.
--   The record is self-contained — it remains accurate even if the source
--   records are later amended or voided.
--
-- Royalty reporting:
--   Royalty period reports are computed from ledger entries with action = 'sold'.
--   ledger_entry_ids on royalty_entries references rows in this table.
--   license_body, royalty_rate, and retail_price_cents are denormalized here
--   so royalty calculations never require a join back to serialized_units.

create table public.inventory_ledger_entries (
  -- Identity
  id                  uuid                    not null  default gen_random_uuid(),

  -- Unit linkage
  unit_id             uuid                    not null  references public.serialized_units (id),

  -- Denormalized unit fields (captured at event time)
  serial_number       text                    not null,
  sku                 text                    not null,
  product_name        text                    not null,

  -- Event
  action              public.ledger_action    not null,
  -- Unit status immediately before this action. Null for 'received' (first entry).
  from_status         public.unit_status,
  -- Unit status after this action.
  to_status           public.unit_status      not null,

  -- Actor
  -- User ID of the operator who performed the action.
  -- For automated actions (fraud lock, reservation release), this is
  -- the service account ID.
  performed_by        uuid                    not null  references auth.users (id),

  -- Context linkage (null when not applicable to the action type)
  -- Populated for: reserved, reservation_released, sold, returned.
  order_id            uuid,
  -- Populated for: sold, returned.
  consultant_id       uuid,

  -- Licensing (denormalized at event time)
  license_body        public.license_body     not null,
  royalty_rate        numeric(5, 4)           not null,
  -- Retail price at time of action.
  -- Populated for: sold, returned. Null for all other actions.
  retail_price_cents  integer,

  -- Free text
  -- Required for: fraud_locked, fraud_released, voided.
  -- Null for all other actions.
  reason              text,

  -- Extensible metadata (e.g. shipping carrier, scan device ID, return condition).
  -- Never use this as a substitute for a typed field.
  metadata            jsonb,

  -- Timestamp (server-generated, immutable)
  -- Wall-clock time of the action in UTC.
  occurred_at         timestamptz             not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint inventory_ledger_entries_pkey
    primary key (id),

  constraint inventory_ledger_entries_royalty_rate_valid
    check (royalty_rate > 0 and royalty_rate <= 1),

  constraint inventory_ledger_entries_retail_price_positive
    check (retail_price_cents is null or retail_price_cents > 0),

  -- 'received' is always the first action; it has no from_status.
  -- All other actions must record the prior status.
  constraint inventory_ledger_entries_from_status_consistent
    check (
      (action = 'received' and from_status is null)
      or
      (action != 'received' and from_status is not null)
    ),

  -- Reason is required for destructive and enforcement actions.
  constraint inventory_ledger_entries_reason_required
    check (
      action not in ('fraud_locked', 'fraud_released', 'voided')
      or reason is not null
    )
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unit history: all ledger entries for a given unit, in chronological order.
-- Primary query for unit audit trail display.
create index inventory_ledger_entries_unit_id_idx
  on public.inventory_ledger_entries (unit_id, occurred_at desc);

-- Royalty period computation: sold events within a date range by license body.
-- This index is the primary driver for royalty report generation.
create index inventory_ledger_entries_sold_license_idx
  on public.inventory_ledger_entries (license_body, occurred_at desc)
  where action = 'sold';

-- Order context: all ledger events for a given order.
create index inventory_ledger_entries_order_id_idx
  on public.inventory_ledger_entries (order_id)
  where order_id is not null;

-- Consultant context: all events attributed to a consultant.
create index inventory_ledger_entries_consultant_id_idx
  on public.inventory_ledger_entries (consultant_id)
  where consultant_id is not null;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.inventory_ledger_entries enable row level security;

-- SELECT: admin and licensor auditors may read the full ledger.
-- Auditors need ledger entries to reconcile royalty reports.
create policy "inventory_ledger_entries_select_privileged"
  on public.inventory_ledger_entries
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Entries are written by privileged service functions.
create policy "inventory_ledger_entries_insert_admin"
  on public.inventory_ledger_entries
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: no policy defined. This table is append-only.
-- DELETE: no policy defined. This table is append-only.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.inventory_ledger_entries is
  'Immutable append-only audit log for every state change on a serialized unit. '
  'The ledger is the source of truth for compliance reporting and royalty calculation. '
  'No UPDATE or DELETE is permitted on this table under any circumstance.';

comment on column public.inventory_ledger_entries.from_status is
  'Unit status immediately before this action. Null only for the initial '
  '''received'' entry. Required for all subsequent actions.';

comment on column public.inventory_ledger_entries.retail_price_cents is
  'Retail price in cents at time of action. Populated for ''sold'' and ''returned'' '
  'actions; null for all others. Used as the royalty base in period reports.';

comment on column public.inventory_ledger_entries.metadata is
  'Extensible JSONB payload for action-specific context: e.g. scan device ID, '
  'carrier name, return condition. Never use this as a substitute for a typed '
  'column. Shape is defined per action in the application service layer.';

comment on column public.inventory_ledger_entries.occurred_at is
  'Wall-clock UTC timestamp of the action, server-generated at insert time. '
  'Immutable — this is the authoritative timestamp for royalty period cutoffs.';
