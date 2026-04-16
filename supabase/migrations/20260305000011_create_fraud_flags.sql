-- =============================================================================
-- Migration: 20260305000011_create_fraud_flags
--
-- Creates:
--   type  public.fraud_signal_source     enum for signal origin
--   type  public.fraud_flag_severity     enum for risk level
--   type  public.fraud_flag_status       enum for investigation lifecycle
--   table public.fraud_flags             unit fraud investigation records
--   RLS   fraud_flags                    admin all; licensor_auditor read
--
-- NOTE: fraud_flags.auto_lock_id FK (→ lock_records) is added in the
--       next migration (20260305000012) after lock_records is created,
--       to resolve the circular reference between the two tables.
-- =============================================================================

-- ─── Enum: fraud_signal_source ────────────────────────────────────────────────
-- Origin of the fraud signal that produced a FraudFlag.
-- Used to triage investigation priority and route to the correct authority.
--
-- SYNC REQUIREMENT: values must match @gtg/types FraudSignalSource exactly.

create type public.fraud_signal_source as enum (
  'hologram_scan_fail',  -- Hologram verification returned invalid
  'duplicate_serial',    -- Same serial number submitted on multiple orders
  'duplicate_hologram',  -- Hologram ID appears on more than one unit record
  'consultant_report',   -- Consultant self-reported a suspected counterfeit
  'customer_report',     -- Customer reported a product authenticity concern
  'licensor_report',     -- CLC or Army flagged a unit in their audit
  'admin_manual',        -- Admin flagged manually during investigation
  'payment_chargeback',  -- Chargeback received; possible stolen card / resale fraud
  'velocity_anomaly'     -- Unusual sale rate on a serial or consultant account
);

-- ─── Enum: fraud_flag_severity ────────────────────────────────────────────────
-- Risk level assigned at flag creation.
-- Determines whether an automatic unit lock is applied (high/critical)
-- and the SLA for investigator response.
--
-- SYNC REQUIREMENT: values must match @gtg/types FraudFlagSeverity exactly.

create type public.fraud_flag_severity as enum (
  'low',      -- Reviewed in next scheduled audit cycle; no auto-lock
  'medium',   -- 7-day investigator SLA; no auto-lock
  'high',     -- 72-hour SLA; unit auto-locked on flag creation
  'critical'  -- 24-hour SLA; unit auto-locked on flag creation
);

-- ─── Enum: fraud_flag_status ──────────────────────────────────────────────────
-- Investigation lifecycle for a FraudFlag.
--
-- SYNC REQUIREMENT: values must match @gtg/types FraudFlagStatus exactly.

create type public.fraud_flag_status as enum (
  'open',          -- Signal received; not yet assigned
  'under_review',  -- Assigned; investigation in progress
  'escalated',     -- Elevated to senior authority or licensor
  'confirmed',     -- Fraud verified; LockRecord applied or already in force
  'dismissed'      -- False positive; no action taken
);

-- ─── Table: fraud_flags ───────────────────────────────────────────────────────
-- Investigation record for a fraud signal against a specific serialized unit.
--
-- Relationship to lock_records:
--   FraudFlag drives the investigative workflow.
--   LockRecord drives the operational consequence (unit status change).
--   One FraudFlag may produce one or more LockRecords across different scopes.
--   auto_lock_id links to the LockRecord automatically created for
--   severity 'high' and 'critical' flags (added as FK in next migration).
--
-- Immutability contract:
--   'open' and 'under_review' flags are updateable.
--   Once 'confirmed' or 'dismissed', the flag is effectively immutable —
--   resolution_note and resolved fields are set and must not change.
--   Hard delete is prohibited.
--
-- Denormalization:
--   serial_number and sku are preserved even if the unit is later voided,
--   ensuring investigation records remain readable in perpetuity.

create table public.fraud_flags (
  -- Identity
  id                    uuid                        not null  default gen_random_uuid(),

  -- Unit linkage
  unit_id               uuid                        not null  references public.serialized_units (id),
  -- Denormalized — preserved if unit is voided during investigation.
  serial_number         text                        not null,
  sku                   text                        not null,

  -- Signal
  source                public.fraud_signal_source  not null,
  severity              public.fraud_flag_severity  not null,

  -- Lifecycle
  status                public.fraud_flag_status    not null  default 'open',

  -- Unit state snapshot at flag creation
  -- Denormalized to determine what state to restore on dismissal.
  unit_status_at_flag   public.unit_status          not null,

  -- Lock linkage
  -- Whether an automatic lock was applied (true for high/critical severity).
  auto_locked           boolean                     not null  default false,
  -- References lock_records.id. FK added in migration 20260305000012.
  -- Null if no auto-lock was applied, or if lock is created manually later.
  auto_lock_id          uuid,

  -- Context linkage (null when not applicable to the signal type)
  -- Populated for: duplicate_serial, payment_chargeback.
  related_order_id      uuid,
  -- Populated for: consultant_report, velocity_anomaly.
  related_consultant_id uuid,
  -- Populated for: licensor_report. Only 'CLC' or 'ARMY' (not full license_body enum).
  reporting_licensor    text,

  -- Signal payload
  -- Raw signal metadata for investigator context (scan device, verify response, etc.).
  signal_metadata       jsonb,
  -- Free-text description of the signal or initial observations. Required.
  description           text                        not null,

  -- Actors
  -- User ID who raised the flag. Service account ID for automated signals.
  raised_by             uuid                        not null  references auth.users (id),
  -- Investigator assigned to this flag. Null until status leaves 'open'.
  assigned_to           uuid                        references auth.users (id),
  assigned_at           timestamptz,

  -- Investigation
  -- Accumulated investigator notes. Appended over time; not replaced.
  investigation_notes   text,
  -- Required when status transitions to 'escalated'.
  escalation_reason     text,

  -- Resolution (required when status reaches 'confirmed' or 'dismissed')
  resolution_note       text,
  resolved_at           timestamptz,
  resolved_by           uuid                        references auth.users (id),

  -- Audit
  created_at            timestamptz                 not null  default now(),
  updated_at            timestamptz                 not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint fraud_flags_pkey
    primary key (id),

  -- reporting_licensor must be 'CLC' or 'ARMY' when set.
  -- Not using license_body enum because 'NONE' is not a valid licensor.
  constraint fraud_flags_reporting_licensor_valid
    check (reporting_licensor in ('CLC', 'ARMY')),

  -- auto_locked = true requires auto_lock_id to be set (or will be set by trigger
  -- in the application layer). When auto_locked = false, auto_lock_id is null.
  -- This is a soft guideline enforced at the application layer, not here,
  -- because auto_lock_id may be set after the flag is created.

  -- Assignment consistency: assigned_at requires assigned_to.
  constraint fraud_flags_assignment_consistent
    check (
      assigned_at is null
      or (assigned_at is not null and assigned_to is not null)
    ),

  -- Resolution consistency: resolved_at requires resolved_by.
  constraint fraud_flags_resolution_consistent
    check (
      resolved_at is null
      or (resolved_at is not null and resolved_by is not null)
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger fraud_flags_set_updated_at
  before update on public.fraud_flags
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Unit → flags: all fraud flags for a given unit (investigation history).
create index fraud_flags_unit_id_idx
  on public.fraud_flags (unit_id);

-- Status filter: find open and under_review flags for the investigation queue.
create index fraud_flags_status_idx
  on public.fraud_flags (status);

-- Severity + status: critical and high open flags for priority queue.
create index fraud_flags_severity_open_idx
  on public.fraud_flags (severity, created_at desc)
  where status in ('open', 'under_review', 'escalated');

-- Source filter: licensor_report flags for CLC/Army coordination.
create index fraud_flags_source_idx
  on public.fraud_flags (source);

-- Investigator assignment.
create index fraud_flags_assigned_to_idx
  on public.fraud_flags (assigned_to)
  where assigned_to is not null;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.fraud_flags enable row level security;

-- SELECT: admins and licensor auditors may read fraud flags.
create policy "fraud_flags_select_privileged"
  on public.fraud_flags
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Flags are created by admin users or service functions.
create policy "fraud_flags_insert_admin"
  on public.fraud_flags
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. Investigation assignment, notes, escalation, resolution.
create policy "fraud_flags_update_admin"
  on public.fraud_flags
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.fraud_flags is
  'Investigation records for fraud signals against serialized units. '
  'FraudFlag drives the investigative workflow; LockRecord drives the '
  'operational consequence. Hard delete prohibited — dismiss with status = ''dismissed''.';

comment on column public.fraud_flags.auto_lock_id is
  'FK → lock_records.id. FK constraint added in the lock_records migration to '
  'resolve the circular reference. Populated when auto_locked = true (severity '
  '''high'' or ''critical'') or when an investigator manually issues a lock.';

comment on column public.fraud_flags.unit_status_at_flag is
  'Unit lifecycle status at the moment the flag was raised. Denormalized to '
  'determine which state to restore if the flag is dismissed and the lock released.';

comment on column public.fraud_flags.signal_metadata is
  'Raw signal payload stored as JSONB for investigator context. Examples: '
  'hologram scan device ID, verify API response body, chargeback notice reference. '
  'Never use this as a substitute for a typed field.';

comment on column public.fraud_flags.investigation_notes is
  'Accumulated investigator notes. Use a dated-entry convention when appending. '
  'Not replaced on update — append new content to preserve the investigation trail.';
