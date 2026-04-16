import type { FraudFlagSeverity, FraudFlagStatus, FraudSignalSource } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { invokeFunction } from './transport'

const VALID_SOURCES: readonly FraudSignalSource[] = [
  'hologram_scan_fail',
  'duplicate_serial',
  'duplicate_hologram',
  'consultant_report',
  'customer_report',
  'licensor_report',
  'admin_manual',
  'payment_chargeback',
  'velocity_anomaly',
]

const VALID_SEVERITIES: readonly FraudFlagSeverity[] = ['low', 'medium', 'high', 'critical']
const VALID_STATUSES: readonly FraudFlagStatus[] = [
  'open',
  'under_review',
  'escalated',
  'confirmed',
  'dismissed',
]

function assertFraudSource(value: string, fnName: string): asserts value is FraudSignalSource {
  if (!VALID_SOURCES.includes(value as FraudSignalSource)) {
    throw new ApiRequestError(`[GTG] ${fnName}(): source is invalid.`, 'VALIDATION_ERROR')
  }
}

function assertFraudSeverity(value: string, fnName: string): asserts value is FraudFlagSeverity {
  if (!VALID_SEVERITIES.includes(value as FraudFlagSeverity)) {
    throw new ApiRequestError(`[GTG] ${fnName}(): severity is invalid.`, 'VALIDATION_ERROR')
  }
}

function assertFraudStatus(value: string, fnName: string): asserts value is FraudFlagStatus {
  if (!VALID_STATUSES.includes(value as FraudFlagStatus)) {
    throw new ApiRequestError(`[GTG] ${fnName}(): status value is invalid.`, 'VALIDATION_ERROR')
  }
}

// ─── Create Fraud Flag ────────────────────────────────────────────────────────

export interface CreateFraudFlagInput {
  unit_id: string
  source: FraudSignalSource
  severity: FraudFlagSeverity
  description: string
  related_order_id?: string
  related_consultant_id?: string
  reporting_licensor?: 'CLC' | 'ARMY'
  signal_metadata?: Record<string, unknown>
}

export interface CreateFraudFlagResult {
  fraud_flag_id: string
  unit_id: string
  source: FraudSignalSource
  severity: FraudFlagSeverity
  lock_record_id: string | null
  auto_locked: boolean
}

export async function createFraudFlag(input: CreateFraudFlagInput): Promise<CreateFraudFlagResult> {
  const {
    unit_id,
    source,
    severity,
    description,
    related_order_id,
    related_consultant_id,
    reporting_licensor,
    signal_metadata,
  } = input

  if (!unit_id || typeof unit_id !== 'string') {
    throw new ApiRequestError('[GTG] createFraudFlag(): unit_id is required.', 'VALIDATION_ERROR')
  }
  assertUuidV4(unit_id, 'unit_id', 'createFraudFlag')
  assertFraudSource(source, 'createFraudFlag')
  assertFraudSeverity(severity, 'createFraudFlag')

  if (!description || description.trim().length === 0) {
    throw new ApiRequestError('[GTG] createFraudFlag(): description is required.', 'VALIDATION_ERROR')
  }
  if (related_order_id !== undefined) {
    assertUuidV4(related_order_id, 'related_order_id', 'createFraudFlag')
  }
  if (related_consultant_id !== undefined) {
    assertUuidV4(related_consultant_id, 'related_consultant_id', 'createFraudFlag')
  }
  if (source === 'payment_chargeback' && !related_order_id) {
    throw new ApiRequestError(
      '[GTG] createFraudFlag(): related_order_id is required for payment_chargeback.',
      'VALIDATION_ERROR',
    )
  }
  if (source === 'licensor_report' && !reporting_licensor) {
    throw new ApiRequestError(
      '[GTG] createFraudFlag(): reporting_licensor is required for licensor_report.',
      'VALIDATION_ERROR',
    )
  }
  if (source !== 'licensor_report' && reporting_licensor !== undefined) {
    throw new ApiRequestError(
      '[GTG] createFraudFlag(): reporting_licensor is only valid when source=licensor_report.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<CreateFraudFlagResult>(
    'create-fraud-flag',
    {
      unit_id,
      source,
      severity,
      description: description.trim(),
      related_order_id,
      related_consultant_id,
      reporting_licensor,
      signal_metadata,
    },
    'createFraudFlag',
  )
}

// ─── View Fraud Events ────────────────────────────────────────────────────────

export interface ViewFraudEventsInput {
  status?: FraudFlagStatus | FraudFlagStatus[]
  severity?: FraudFlagSeverity | FraudFlagSeverity[]
  source?: FraudSignalSource
  unit_id?: string
  assigned_to?: string
  auto_locked?: boolean
  limit?: number
  offset?: number
}

export interface FraudEventListItem {
  id: string
  unit_id: string
  serial_number: string
  sku: string
  source: FraudSignalSource
  severity: FraudFlagSeverity
  status: FraudFlagStatus
  unit_status_at_flag: string
  auto_locked: boolean
  auto_lock_id: string | null
  related_order_id: string | null
  related_consultant_id: string | null
  reporting_licensor: 'CLC' | 'ARMY' | null
  signal_metadata: Record<string, unknown> | null
  description: string
  raised_by: string
  assigned_to: string | null
  assigned_at: string | null
  investigation_notes: string | null
  escalation_reason: string | null
  resolution_note: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export interface ViewFraudEventsResult {
  flags: FraudEventListItem[]
  total: number
  limit: number
  offset: number
}

export async function viewFraudEvents(
  input: ViewFraudEventsInput = {},
): Promise<ViewFraudEventsResult> {
  const { status, severity, source, unit_id, assigned_to, auto_locked, limit, offset } = input

  if (status !== undefined) {
    const values = Array.isArray(status) ? status : [status]
    if (values.length === 0) {
      throw new ApiRequestError(
        '[GTG] viewFraudEvents(): status filter must not be empty.',
        'VALIDATION_ERROR',
      )
    }
    for (const v of values) assertFraudStatus(v, 'viewFraudEvents')
  }

  if (severity !== undefined) {
    const values = Array.isArray(severity) ? severity : [severity]
    if (values.length === 0) {
      throw new ApiRequestError(
        '[GTG] viewFraudEvents(): severity filter must not be empty.',
        'VALIDATION_ERROR',
      )
    }
    for (const v of values) assertFraudSeverity(v, 'viewFraudEvents')
  }

  if (source !== undefined) assertFraudSource(source, 'viewFraudEvents')
  if (unit_id !== undefined) assertUuidV4(unit_id, 'unit_id', 'viewFraudEvents')
  if (assigned_to !== undefined) assertUuidV4(assigned_to, 'assigned_to', 'viewFraudEvents')

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new ApiRequestError(
      '[GTG] viewFraudEvents(): limit must be an integer between 1 and 200.',
      'VALIDATION_ERROR',
    )
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new ApiRequestError(
      '[GTG] viewFraudEvents(): offset must be a non-negative integer.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ViewFraudEventsResult>(
    'view-fraud-events',
    {
      ...(status !== undefined ? { status } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(unit_id !== undefined ? { unit_id } : {}),
      ...(assigned_to !== undefined ? { assigned_to } : {}),
      ...(auto_locked !== undefined ? { auto_locked } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
    'viewFraudEvents',
  )
}

// ─── Escalate Fraud Flag ──────────────────────────────────────────────────────

export interface EscalateFraudFlagInput {
  fraud_flag_id: string
  escalation_reason: string
  assign_to?: string
}

export interface EscalateFraudFlagResult {
  fraud_flag_id: string
  unit_id: string
  serial_number: string
  source: FraudSignalSource
  severity: FraudFlagSeverity
  previous_status: FraudFlagStatus
  status: FraudFlagStatus
  escalation_reason: string
  assigned_to: string | null
  assigned_at: string | null
  updated_at: string
}

export async function escalateFraudFlag(
  input: EscalateFraudFlagInput,
): Promise<EscalateFraudFlagResult> {
  const { fraud_flag_id, escalation_reason, assign_to } = input

  assertUuidV4(fraud_flag_id, 'fraud_flag_id', 'escalateFraudFlag')
  if (!escalation_reason || escalation_reason.trim() === '') {
    throw new ApiRequestError(
      '[GTG] escalateFraudFlag(): escalation_reason is required.',
      'VALIDATION_ERROR',
    )
  }
  if (assign_to !== undefined) {
    assertUuidV4(assign_to, 'assign_to', 'escalateFraudFlag')
  }

  return invokeFunction<EscalateFraudFlagResult>(
    'escalate-fraud-flag',
    {
      fraud_flag_id,
      escalation_reason: escalation_reason.trim(),
      assign_to,
    },
    'escalateFraudFlag',
  )
}

// ─── Resolve Fraud Flag ───────────────────────────────────────────────────────

export interface ResolveFraudFlagInput {
  fraud_flag_id: string
  resolution: 'confirmed' | 'dismissed'
  resolution_note: string
  release_reference_id?: string
}

export interface ResolveFraudFlagReleasedLock {
  lock_record_id: string
  unit_id: string
  restored_status: string
  ledger_entry_id: string
}

export interface ResolveFraudFlagResult {
  fraud_flag_id: string
  unit_id: string
  serial_number: string
  resolution: 'confirmed' | 'dismissed'
  status: FraudFlagStatus
  resolution_note: string
  resolved_at: string
  resolved_by: string
  locks_released: ResolveFraudFlagReleasedLock[]
}

export async function resolveFraudFlag(
  input: ResolveFraudFlagInput,
): Promise<ResolveFraudFlagResult> {
  const { fraud_flag_id, resolution, resolution_note, release_reference_id } = input

  assertUuidV4(fraud_flag_id, 'fraud_flag_id', 'resolveFraudFlag')
  if (resolution !== 'confirmed' && resolution !== 'dismissed') {
    throw new ApiRequestError(
      "[GTG] resolveFraudFlag(): resolution must be 'confirmed' or 'dismissed'.",
      'VALIDATION_ERROR',
    )
  }
  if (!resolution_note || resolution_note.trim() === '') {
    throw new ApiRequestError(
      '[GTG] resolveFraudFlag(): resolution_note is required.',
      'VALIDATION_ERROR',
    )
  }
  if (release_reference_id !== undefined && release_reference_id.trim() === '') {
    throw new ApiRequestError(
      '[GTG] resolveFraudFlag(): release_reference_id cannot be blank.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ResolveFraudFlagResult>(
    'resolve-fraud-flag',
    {
      fraud_flag_id,
      resolution,
      resolution_note: resolution_note.trim(),
      release_reference_id,
    },
    'resolveFraudFlag',
  )
}

// ─── Fraud Warning ────────────────────────────────────────────────────────────

export interface GetFraudWarningResult {
  serial_number: string
  has_warning: boolean
  warning_level: 'none' | 'caution' | 'alert'
  warning_code: 'none' | 'not_recognized' | 'under_review' | 'confirmed_fraud' | 'decommissioned'
  headline: string | null
  guidance: string | null
  flagged_at: string | null
}

export async function getFraudWarning(serialNumber: string): Promise<GetFraudWarningResult> {
  if (!serialNumber || serialNumber.trim() === '') {
    throw new ApiRequestError(
      '[GTG] getFraudWarning(): serialNumber is required.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<GetFraudWarningResult>(
    'get-fraud-warning',
    { serial_number: serialNumber.trim() },
    'getFraudWarning',
  )
}
