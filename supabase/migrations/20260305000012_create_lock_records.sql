-- =============================================================================
-- Migration: 20260305000012_create_lock_records
--
-- Creates:
--   type  public.lock_scope              enum for what a lock targets
--   type  public.lock_authority          enum for who holds lock authority
--   table public.lock_records            enforcement lock records (append-only)
--   RLS   lock_records                   admin all; licensor_auditor read
--   alter public.fraud_flags             adds auto_lock_id FK constraint
--                                        (resolves circular reference)
-- =============================================================================

-- ─── Enum: lock_scope ─────────────────────────────────────────────────────────
-- What a LockRecord targets. A single fraud event may produce locks at
-- multiple scopes simultaneously.
--
-- SYNC REQUIREMENT: values must match @gtg/types LockScope exactly.

create type public.lock_scope as enum (
  'unit',        -- Specific SerializedUnit → status = 'fraud_locked'
  'consultant',  -- ConsultantProfile → status = 'suspended'
  'order'        -- Order is frozen pending investigation
);

-- ─── Enum: lock_authority ─────────────────────────────────────────────────────
-- Who holds the authority to apply or lift a lock.
-- Authority is recorded on every lock action for compliance.
-- A lock issued under 'clc' or 'army' authority cannot be released without
-- the corresponding authority's explicit approval.
--
-- SYNC REQUIREMENT: values must match @gtg/types LockAuthority exactly.

create type public.lock_authority as enum (
  'gtg_admin',  -- Internal GTG administrator
  'clc',        -- Collegiate Licensing Company
  'army',       -- U.S. Army licensing authority
  'system'      -- Automated lock triggered by severity rule (critical/high)
);

-- ─── Table: lock_records ──────────────────────────────────────────────────────
-- Authoritative enforcement lock records.
-- Where fraud_flags tracks the investigation, lock_records tracks the
-- operational consequence — who locked what, under what authority,
-- and when (or whether) it was released.
--
-- Append-only contract:
--   Locks are never deleted. Lifting a lock sets is_active = false and
--   populates the release fields. The full lock history is preserved on
--   each row — there is no separate "release" table.
--
-- Compliance requirement:
--   Every lock and every release must identify the authority who authorized
--   the action. A lock applied by 'army' cannot be released without army
--   authority (release_authority = 'army' or 'gtg_admin' with licensor approval).
--
-- Circular reference:
--   fraud_flags.auto_lock_id → lock_records.id
--   lock_records.fraud_flag_id → fraud_flags.id
--   Both are nullable; the FK from fraud_flags is added at the end of this
--   migration now that lock_records exists.

create table public.lock_records (
  -- Identity
  id                      uuid                      not null  default gen_random_uuid(),

  -- Source flag (null for licensor-mandated locks without a prior flag)
  fraud_flag_id           uuid                      references public.fraud_flags (id),

  -- Target
  scope                   public.lock_scope         not null,
  -- The ID of the locked entity, resolved by scope:
  --   scope = 'unit'       → serialized_units.id
  --   scope = 'consultant' → consultant_profiles.id
  --   scope = 'order'      → orders.id
  -- Stored as text (not uuid) to accommodate future non-UUID target systems,
  -- but in practice always a UUID for the current scopes.
  target_id               text                      not null,
  -- Denormalized label for audit display:
  --   scope = 'unit'       → serial number
  --   scope = 'consultant' → consultant legal name
  --   scope = 'order'      → order number
  target_label            text                      not null,

  -- Authority
  lock_authority          public.lock_authority     not null,

  -- State snapshot
  -- Status of the target entity immediately before the lock was applied.
  -- Required to restore correct state on release.
  -- Typed as text (not an enum) to avoid circular import issues — the
  -- status enums for consultant and order scopes live in separate types.
  status_before_lock      text                      not null,

  -- Lifecycle
  is_active               boolean                   not null  default true,

  -- Lock details
  lock_reason             text                      not null,
  -- External reference from the licensor authorizing this lock.
  -- Populated for lock_authority = 'clc' or 'army'. Null for internal locks.
  licensor_reference_id   text,

  -- Lock actor
  -- User ID who applied the lock. Service account ID for 'system' locks.
  locked_by               uuid                      not null  references auth.users (id),
  locked_at               timestamptz               not null  default now(),

  -- Release fields (null while is_active = true)
  -- All four release fields must be populated together when releasing.
  release_reason          text,
  release_authority       public.lock_authority,
  -- External reference from the licensor authorizing the release.
  -- Required for release_authority = 'clc' or 'army'.
  release_reference_id    text,
  released_by             uuid                      references auth.users (id),
  released_at             timestamptz,

  -- Audit
  created_at              timestamptz               not null  default now(),
  updated_at              timestamptz               not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint lock_records_pkey
    primary key (id),

  -- Release fields must be completely null or completely non-null.
  -- A partial release is a data integrity violation.
  constraint lock_records_release_consistent
    check (
      (
        is_active = true
        and release_reason is null
        and release_authority is null
        and released_by is null
        and released_at is null
      )
      or
      (
        is_active = false
        and release_reason is not null
        and release_authority is not null
        and released_by is not null
        and released_at is not null
      )
    ),

  -- licensor locks must carry a reference when created.
  -- Internal and system locks need no external reference.
  constraint lock_records_licensor_reference_required
    check (
      lock_authority not in ('clc', 'army')
      or licensor_reference_id is not null
    )
);

-- ─── updated_at Trigger ───────────────────────────────────────────────────────

create trigger lock_records_set_updated_at
  before update on public.lock_records
  for each row
  execute function public.set_updated_at();

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Active locks by scope + target: primary query to check whether a unit,
-- consultant, or order is currently locked.
create index lock_records_target_active_idx
  on public.lock_records (scope, target_id)
  where is_active = true;

-- Fraud flag → lock records: list all locks produced by a flag.
create index lock_records_fraud_flag_id_idx
  on public.lock_records (fraud_flag_id)
  where fraud_flag_id is not null;

-- Authority: list all active locks held by a specific authority.
-- Used for CLC or Army audit requests.
create index lock_records_authority_active_idx
  on public.lock_records (lock_authority)
  where is_active = true;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.lock_records enable row level security;

-- SELECT: admins and licensor auditors may read lock records.
-- Auditors from CLC or Army need to see locks under their authority.
create policy "lock_records_select_privileged"
  on public.lock_records
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Locks are created by admin users or automated fraud rules.
create policy "lock_records_insert_admin"
  on public.lock_records
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: admin only. is_active → false (release) and release fields.
create policy "lock_records_update_admin"
  on public.lock_records
  for update
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- DELETE: prohibited. Lock history is retained permanently for compliance.

-- ─── Deferred FK: fraud_flags.auto_lock_id → lock_records ────────────────────
-- This resolves the circular reference between fraud_flags and lock_records.
-- fraud_flags was created without the auto_lock_id FK because lock_records
-- did not yet exist. Now that lock_records exists, the constraint is safe.

alter table public.fraud_flags
  add constraint fraud_flags_auto_lock_id_fkey
    foreign key (auto_lock_id) references public.lock_records (id);

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.lock_records is
  'Authoritative enforcement lock records. Each row records one lock action '
  'and its eventual release. Append-only — locks are never deleted. '
  'Releasing a lock sets is_active = false and populates the release fields.';

comment on column public.lock_records.status_before_lock is
  'Status of the target entity immediately before the lock was applied. '
  'Used to restore the correct state when the lock is released. '
  'Typed as text (not an enum) to accommodate unit, consultant, and order '
  'status enums without importing all modules.';

comment on column public.lock_records.is_active is
  'Whether this lock is currently in force. Set to false (with release fields '
  'populated) to lift the lock. The check constraint enforces that all release '
  'fields are populated atomically when is_active transitions to false.';

comment on column public.lock_records.licensor_reference_id is
  'External reference from the licensor authorizing this lock. Required for '
  'lock_authority = ''clc'' or ''army''. Enables lookup of the original '
  'licensor correspondence for audit and dispute purposes.';

comment on column public.lock_records.release_reference_id is
  'External reference from the licensor authorizing the release. '
  'Required when release_authority = ''clc'' or ''army''. '
  'Null for internal releases or while lock is still active.';
