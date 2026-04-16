/**
 * Admin-scoped operations on consultant accounts and commission configuration.
 *
 * All functions in this module require an active session with role 'admin'
 * or 'super_admin'. Authorization is enforced server-side by each Edge Function
 * and by RLS on direct table reads — the client makes no authorization decisions.
 *
 * Financial boundary:
 *   All status transitions (approve, suspend, terminate, reactivate) and
 *   tier changes route through Edge Functions — never written directly.
 *   List/read operations query the consultant_profiles table directly;
 *   RLS ensures only admin sessions can see all rows.
 */

import type { CommissionTier, ConsultantStatus } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction } from './transport'
import type { Database } from './transport'

type ConsultantProfileRow = Database['public']['Tables']['consultant_profiles']['Row']

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_TIERS: CommissionTier[] = ['standard', 'senior', 'elite', 'custom']

function assertConsultantId(consultantId: string, fnName: string): void {
  if (!consultantId || typeof consultantId !== 'string') {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): consultantId is required.`,
      'VALIDATION_ERROR',
    )
  }
  assertUuidV4(consultantId, 'consultantId', fnName)
}

function assertTier(tier: string, fnName: string): asserts tier is CommissionTier {
  if (!VALID_TIERS.includes(tier as CommissionTier)) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): commission_tier must be one of standard, senior, elite, custom.`,
      'VALIDATION_ERROR',
    )
  }
}

// ─── Create Consultant ────────────────────────────────────────────────────────

export interface CreateConsultantInput {
  /** Existing auth.users.id — the account must be provisioned in Supabase Auth first. */
  authUserId: string
  legalFirstName: string
  legalLastName: string
  displayName: string
  email: string
  phone?: string
  /** Defaults to 'standard'. */
  commissionTier?: CommissionTier
  /** Required when commissionTier is 'custom'. */
  customCommissionRate?: number
  /** consultant_profiles.id of the referring consultant. */
  referredBy?: string
}

export interface CreateConsultantResult {
  consultant_id: string
  auth_user_id: string
  status: ConsultantStatus
  display_name: string
  email: string
  commission_tier: CommissionTier
  custom_commission_rate: number | null
  created_at: string
}

/**
 * Create a consultant profile for an existing Supabase Auth user.
 *
 * The auth account must exist before calling this. Tax onboarding
 * (tax_id, address) is a separate post-creation workflow — never accepted here.
 */
export async function createConsultant(
  input: CreateConsultantInput,
): Promise<CreateConsultantResult> {
  const {
    authUserId,
    legalFirstName,
    legalLastName,
    displayName,
    email,
    phone,
    commissionTier,
    customCommissionRate,
    referredBy,
  } = input

  assertUuidV4(authUserId, 'authUserId', 'createConsultant')

  if (!legalFirstName?.trim()) {
    throw new ApiRequestError('[GTG] createConsultant(): legalFirstName is required.', 'VALIDATION_ERROR')
  }
  if (!legalLastName?.trim()) {
    throw new ApiRequestError('[GTG] createConsultant(): legalLastName is required.', 'VALIDATION_ERROR')
  }
  if (!displayName?.trim()) {
    throw new ApiRequestError('[GTG] createConsultant(): displayName is required.', 'VALIDATION_ERROR')
  }
  if (!email?.trim()) {
    throw new ApiRequestError('[GTG] createConsultant(): email is required.', 'VALIDATION_ERROR')
  }

  if (commissionTier !== undefined) {
    assertTier(commissionTier, 'createConsultant')
  }

  if (commissionTier === 'custom') {
    if (
      customCommissionRate === undefined ||
      typeof customCommissionRate !== 'number' ||
      customCommissionRate <= 0 ||
      customCommissionRate >= 1
    ) {
      throw new ApiRequestError(
        '[GTG] createConsultant(): customCommissionRate is required for custom tier (decimal 0–1 exclusive).',
        'VALIDATION_ERROR',
      )
    }
  } else if (customCommissionRate !== undefined) {
    throw new ApiRequestError(
      '[GTG] createConsultant(): customCommissionRate is only valid when commissionTier is custom.',
      'VALIDATION_ERROR',
    )
  }

  if (referredBy !== undefined) {
    assertUuidV4(referredBy, 'referredBy', 'createConsultant')
  }

  return invokeFunction<CreateConsultantResult>(
    'create-consultant',
    {
      auth_user_id: authUserId,
      legal_first_name: legalFirstName.trim(),
      legal_last_name: legalLastName.trim(),
      display_name: displayName.trim(),
      email: email.trim().toLowerCase(),
      ...(phone ? { phone: phone.trim() } : {}),
      ...(commissionTier ? { commission_tier: commissionTier } : {}),
      ...(customCommissionRate !== undefined ? { custom_commission_rate: customCommissionRate } : {}),
      ...(referredBy ? { referred_by: referredBy } : {}),
    },
    'createConsultant',
  )
}

// ─── List Consultants ─────────────────────────────────────────────────────────

export interface ListConsultantsInput {
  status?: ConsultantStatus
  tier?: CommissionTier
  /** Full-text search against display_name and email. */
  search?: string
  limit?: number
  offset?: number
}

export interface ListConsultantsResult {
  consultants: ConsultantProfileRow[]
  total: number
  limit: number
  offset: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

/**
 * List consultant profiles with optional filtering.
 *
 * Requires admin role — RLS on consultant_profiles restricts non-admin
 * sessions to their own row only.
 */
export async function listConsultants(
  input: ListConsultantsInput = {},
): Promise<ListConsultantsResult> {
  const { status, tier, search, limit: rawLimit, offset: rawOffset } = input

  const limit = rawLimit ?? DEFAULT_LIST_LIMIT
  const offset = rawOffset ?? 0

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiRequestError(
      `[GTG] listConsultants(): limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
      'VALIDATION_ERROR',
    )
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiRequestError(
      '[GTG] listConsultants(): offset must be a non-negative integer.',
      'VALIDATION_ERROR',
    )
  }

  const client = getTableClient()

  let query = client
    .from('consultant_profiles')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (tier) query = query.eq('commission_tier', tier)
  if (search?.trim()) {
    const term = `%${search.trim()}%`
    query = query.or(`display_name.ilike.${term},email.ilike.${term}`)
  }

  const { data, count, error } = await query

  if (error) {
    throw new ApiRequestError(
      `[GTG] listConsultants(): query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  return {
    consultants: (data ?? []) as ConsultantProfileRow[],
    total: count ?? 0,
    limit,
    offset,
  }
}

// ─── Status Transitions ───────────────────────────────────────────────────────

export interface ConsultantStatusChangeResult {
  consultant_id: string
  display_name: string
  previous_status: ConsultantStatus
  status: ConsultantStatus
  changed_at: string
  changed_by: string
  reason: string
}

export interface ApproveConsultantInput {
  consultantId: string
  note?: string
}

/** Approve a pending_approval consultant — transitions status to 'active'. */
export async function approveConsultant(
  input: ApproveConsultantInput,
): Promise<ConsultantStatusChangeResult> {
  assertConsultantId(input.consultantId, 'approveConsultant')

  return invokeFunction<ConsultantStatusChangeResult>(
    'approve-consultant',
    {
      consultant_id: input.consultantId,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    'approveConsultant',
  )
}

export interface SuspendConsultantInput {
  consultantId: string
  reason: string
}

/**
 * Suspend an active consultant — transitions status to 'suspended'.
 * Pending commissions are placed on hold until reactivation.
 */
export async function suspendConsultant(
  input: SuspendConsultantInput,
): Promise<ConsultantStatusChangeResult> {
  assertConsultantId(input.consultantId, 'suspendConsultant')

  if (!input.reason?.trim()) {
    throw new ApiRequestError(
      '[GTG] suspendConsultant(): reason is required.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ConsultantStatusChangeResult>(
    'suspend-consultant',
    { consultant_id: input.consultantId, reason: input.reason.trim() },
    'suspendConsultant',
  )
}

export interface TerminateConsultantInput {
  consultantId: string
  reason: string
}

/**
 * Permanently terminate a consultant account.
 * Commissions in 'earned' or 'held' status are voided server-side.
 */
export async function terminateConsultant(
  input: TerminateConsultantInput,
): Promise<ConsultantStatusChangeResult> {
  assertConsultantId(input.consultantId, 'terminateConsultant')

  if (!input.reason?.trim()) {
    throw new ApiRequestError(
      '[GTG] terminateConsultant(): reason is required.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ConsultantStatusChangeResult>(
    'terminate-consultant',
    { consultant_id: input.consultantId, reason: input.reason.trim() },
    'terminateConsultant',
  )
}

export interface ReactivateConsultantInput {
  consultantId: string
  note?: string
}

/**
 * Reactivate a suspended consultant — transitions status back to 'active'.
 * Held commissions are released to 'earned' status server-side.
 */
export async function reactivateConsultant(
  input: ReactivateConsultantInput,
): Promise<ConsultantStatusChangeResult> {
  assertConsultantId(input.consultantId, 'reactivateConsultant')

  return invokeFunction<ConsultantStatusChangeResult>(
    'reactivate-consultant',
    {
      consultant_id: input.consultantId,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    'reactivateConsultant',
  )
}

// ─── Commission Tier Assignment ───────────────────────────────────────────────

export interface AssignConsultantCommissionRateInput {
  consultantId: string
  commissionTier: CommissionTier
  /** Required when commissionTier is 'custom'. Decimal 0–1 exclusive. */
  customCommissionRate?: number
}

export interface AssignConsultantCommissionRateResult {
  consultant_id: string
  display_name: string
  commission_tier: CommissionTier
  custom_commission_rate: number | null
  previous_tier: CommissionTier
  previous_rate: number | null
}

/**
 * Change a consultant's commission tier (and custom rate if applicable).
 * Takes effect immediately; existing commission_entries are NOT retroactively recalculated.
 */
export async function assignConsultantCommissionRate(
  input: AssignConsultantCommissionRateInput,
): Promise<AssignConsultantCommissionRateResult> {
  const { consultantId, commissionTier, customCommissionRate } = input

  assertConsultantId(consultantId, 'assignConsultantCommissionRate')
  assertTier(commissionTier, 'assignConsultantCommissionRate')

  if (commissionTier === 'custom') {
    if (
      customCommissionRate === undefined ||
      typeof customCommissionRate !== 'number' ||
      customCommissionRate <= 0 ||
      customCommissionRate >= 1
    ) {
      throw new ApiRequestError(
        '[GTG] assignConsultantCommissionRate(): customCommissionRate is required for custom tier (decimal 0–1 exclusive).',
        'VALIDATION_ERROR',
      )
    }
  } else if (customCommissionRate !== undefined) {
    throw new ApiRequestError(
      '[GTG] assignConsultantCommissionRate(): customCommissionRate is only valid when commissionTier is custom.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<AssignConsultantCommissionRateResult>(
    'assign-commission-rate',
    {
      consultant_id: consultantId,
      commission_tier: commissionTier,
      ...(customCommissionRate !== undefined ? { custom_commission_rate: customCommissionRate } : {}),
    },
    'assignConsultantCommissionRate',
  )
}

// ─── Commission Payout Approval ───────────────────────────────────────────────

export interface ApprovePayoutsInput {
  /** Approve commissions for a specific consultant only. */
  consultantId?: string
  /** Approve only entries created on or before this date (YYYY-MM-DD). */
  earnedBefore?: string
}

export interface ApprovedPayoutEntry {
  commission_entry_id: string
  consultant_id: string
  display_name: string
  commission_cents: number
  approved_at: string
}

export interface ApprovePayoutsResult {
  approved_count: number
  total_approved_cents: number
  entries: ApprovedPayoutEntry[]
}

/**
 * Approve earned commission entries for payout.
 * Transitions matching 'earned' commission_entries to 'approved' status.
 */
export async function approvePayouts(
  input: ApprovePayoutsInput = {},
): Promise<ApprovePayoutsResult> {
  const { consultantId, earnedBefore } = input

  if (consultantId !== undefined) {
    assertUuidV4(consultantId, 'consultantId', 'approvePayouts')
  }
  if (earnedBefore !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(earnedBefore)) {
    throw new ApiRequestError(
      '[GTG] approvePayouts(): earnedBefore must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ApprovePayoutsResult>(
    'approve-payouts',
    {
      ...(consultantId ? { consultant_id: consultantId } : {}),
      ...(earnedBefore ? { earned_before: earnedBefore } : {}),
    },
    'approvePayouts',
  )
}

// ─── Lock Unit ────────────────────────────────────────────────────────────────

export interface LockUnitInput {
  /**
   * Target serialized unit ID (UUID v4). Required.
   */
  unitId: string
  /**
   * Human-readable reason for the lock — required for compliance audit.
   * Preserved on the LockRecord for the audit trail.
   */
  reason: string
}

export interface LockUnitResult {
  /** The created lock_records row ID — required to release this lock. */
  lock_record_id: string
  unit_id: string
  serial_number: string | null
  lock_authority: string
  ledger_entry_id: string
}

/**
 * Administratively lock a serialized unit.
 *
 * Calls manual-lock-unit (action: "lock"), which atomically:
 *   1. Updates unit status to fraud_locked
 *   2. Creates a lock_records row
 *   3. Appends a fraud_locked inventory_ledger_entries row
 *
 * Returns a lock_record_id — save this to unlock the unit later.
 *
 * Authority: gtg_admin only. Enforced server-side via ADMIN_ROLES check.
 */
export async function lockUnit(input: LockUnitInput): Promise<LockUnitResult> {
  const { unitId, reason } = input

  assertUuidV4(unitId.trim(), 'unitId', 'lockUnit')
  if (!reason || reason.trim().length === 0) {
    throw new ApiRequestError('[GTG] lockUnit(): reason is required.', 'VALIDATION_ERROR')
  }

  return invokeFunction<LockUnitResult>(
    'manual-lock-unit',
    {
      action: 'lock',
      unit_id: unitId.trim(),
      reason: reason.trim(),
    },
    'lockUnit',
  )
}

// ─── Unlock Unit ──────────────────────────────────────────────────────────────

export interface UnlockUnitInput {
  /**
   * The lock_record_id to release.
   * Obtain from the LockUnitResult returned when the unit was locked.
   */
  lockRecordId: string
  /**
   * Explanation for the release — required for compliance audit.
   * Documents why the hold was determined to be unwarranted or resolved.
   */
  releaseReason: string
}

export interface UnlockUnitResult {
  lock_record_id: string
  unit_id: string
  serial_number: string
  restored_status: string
  ledger_entry_id: string
  release_authority: string
}

/**
 * Release a unit lock by calling release-unit-lock.
 *
 * Atomically:
 *   1. Deactivates the lock_records row (is_active → false)
 *   2. Restores serialized_units.status to its pre-lock value
 *   3. Appends a fraud_released inventory_ledger_entries row
 *
 * Note: releasing a lock does NOT close the associated fraud_flag.
 * The investigation workflow continues independently.
 *
 * Authority: gtg_admin only. Enforced server-side via ADMIN_ROLES check.
 */
export async function unlockUnit(input: UnlockUnitInput): Promise<UnlockUnitResult> {
  const { lockRecordId, releaseReason } = input

  assertUuidV4(lockRecordId, 'lockRecordId', 'unlockUnit')
  if (!releaseReason || releaseReason.trim().length === 0) {
    throw new ApiRequestError('[GTG] unlockUnit(): releaseReason is required.', 'VALIDATION_ERROR')
  }

  return invokeFunction<UnlockUnitResult>(
    'release-unit-lock',
    {
      lock_record_id: lockRecordId.trim(),
      release_reason: releaseReason.trim(),
      release_authority: 'gtg_admin',
    },
    'unlockUnit',
  )
}
