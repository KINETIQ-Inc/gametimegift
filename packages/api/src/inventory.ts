import type { UnitStatus } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction, invokeFunctionMultipart } from './transport'
import type { Database } from './transport'

type SerializedUnitRow = Database['public']['Tables']['serialized_units']['Row']

const UNIT_STATUSES: UnitStatus[] = [
  'available',
  'reserved',
  'sold',
  'fraud_locked',
  'returned',
  'voided',
]

// ─── Get Serialized Unit ──────────────────────────────────────────────────────

export interface GetSerializedUnitInput {
  unitId: string
}

/**
 * Fetch a serialized unit by ID.
 *
 * Returns null when the unit does not exist or is not visible to the current
 * authenticated user under RLS.
 */
export async function getSerializedUnit(
  input: GetSerializedUnitInput,
): Promise<SerializedUnitRow | null> {
  const { unitId } = input

  if (!unitId || typeof unitId !== 'string') {
    throw new ApiRequestError('[GTG] getSerializedUnit(): unitId is required.', 'VALIDATION_ERROR')
  }
  assertUuidV4(unitId, 'unitId', 'getSerializedUnit')

  const client = getTableClient()
  const { data, error } = await client
    .from('serialized_units')
    .select('*')
    .eq('id', unitId)
    .maybeSingle()

  if (error) {
    throw new ApiRequestError(
      `[GTG] getSerializedUnit(): query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  return (data ?? null) as SerializedUnitRow | null
}

// ─── Inventory Status ─────────────────────────────────────────────────────────

export interface GetInventoryStatusResult {
  total: number
  byStatus: Record<UnitStatus, number>
}

/**
 * Fetch high-level inventory status counts.
 * Read-only aggregate for dashboards and operational views.
 */
export async function getInventoryStatus(): Promise<GetInventoryStatusResult> {
  const client = getTableClient()

  const { count: totalCount, error: totalError } = await client
    .from('serialized_units')
    .select('id', { count: 'exact', head: true })

  if (totalError) {
    throw new ApiRequestError(
      `[GTG] getInventoryStatus(): total count query failed: ${totalError.message}`,
      'QUERY_ERROR',
    )
  }

  const statusCounts = await Promise.all(
    UNIT_STATUSES.map(async (status) => {
      const { count, error } = await client
        .from('serialized_units')
        .select('id', { count: 'exact', head: true })
        .eq('status', status)

      if (error) {
        throw new ApiRequestError(
          `[GTG] getInventoryStatus(): ${status} count query failed: ${error.message}`,
          'QUERY_ERROR',
        )
      }

      return [status, count ?? 0] as const
    }),
  )

  return {
    total: totalCount ?? 0,
    byStatus: Object.fromEntries(statusCounts) as Record<UnitStatus, number>,
  }
}

// ─── Bulk Upload ──────────────────────────────────────────────────────────────

export interface BulkUploadSerializedUnitsInput {
  productId: string
  batchNumber: string
  expectedUnitCount: number
  csvFile: unknown
  purchaseOrderNumber?: string
  notes?: string
}

export interface BulkUploadSerializedUnitsResult {
  batch_id: string
  batch_number: string
  product_id: string
  sku: string
  license_body: string
  royalty_rate_stamped: number
  expected_unit_count: number
  submitted_count: number
  received_count: number
  conflict_count: number
  conflict_serials: string[]
}

/**
 * Upload a serialized unit CSV and create a manufacturing batch.
 * Routes to the `bulk-upload-units` Edge Function.
 */
export async function bulkUploadSerializedUnits(
  input: BulkUploadSerializedUnitsInput,
): Promise<BulkUploadSerializedUnitsResult> {
  const { productId, batchNumber, expectedUnitCount, csvFile, purchaseOrderNumber, notes } = input

  if (!productId || typeof productId !== 'string') {
    throw new ApiRequestError(
      '[GTG] bulkUploadSerializedUnits(): productId is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!batchNumber || typeof batchNumber !== 'string') {
    throw new ApiRequestError(
      '[GTG] bulkUploadSerializedUnits(): batchNumber is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!Number.isInteger(expectedUnitCount) || expectedUnitCount <= 0) {
    throw new ApiRequestError(
      '[GTG] bulkUploadSerializedUnits(): expectedUnitCount must be a positive integer.',
      'VALIDATION_ERROR',
    )
  }
  if (!csvFile || typeof csvFile !== 'object') {
    throw new ApiRequestError(
      '[GTG] bulkUploadSerializedUnits(): csvFile is required.',
      'VALIDATION_ERROR',
    )
  }

  const runtime = globalThis as unknown as {
    FormData?: new () => { append: (...args: unknown[]) => void }
  }
  if (!runtime.FormData) {
    throw new ApiRequestError(
      '[GTG] bulkUploadSerializedUnits(): FormData is unavailable in this runtime.',
      'VALIDATION_ERROR',
    )
  }

  const formData = new runtime.FormData() as FormData
  ;(formData as unknown as { append: (...args: unknown[]) => void }).append('product_id', productId)
  ;(formData as unknown as { append: (...args: unknown[]) => void }).append('batch_number', batchNumber)
  ;(formData as unknown as { append: (...args: unknown[]) => void }).append('expected_unit_count', String(expectedUnitCount))
  if (purchaseOrderNumber?.trim()) {
    ;(formData as unknown as { append: (...args: unknown[]) => void }).append('purchase_order_number', purchaseOrderNumber.trim())
  }
  if (notes?.trim()) {
    ;(formData as unknown as { append: (...args: unknown[]) => void }).append('notes', notes.trim())
  }
  const fileName = (csvFile as { name?: string }).name ?? 'units.csv'
  ;(formData as unknown as { append: (...args: unknown[]) => void }).append('file', csvFile, fileName)

  return invokeFunctionMultipart<BulkUploadSerializedUnitsResult>(
    'bulk-upload-units',
    formData,
    'bulkUploadSerializedUnits',
  )
}

// ─── Validate Batch ───────────────────────────────────────────────────────────

interface ManufacturingBatchRow {
  id: string
  batch_number: string
  product_id: string
  sku: string
  license_body: string
  expected_unit_count: number
  received_unit_count: number
  purchase_order_number: string | null
  notes: string | null
  received_at: string
}

interface BatchUnitStatusRow {
  status: string
}

export interface ValidateBatchInput {
  batchId?: string
  batchNumber?: string
}

export interface ValidateBatchResult {
  batch: ManufacturingBatchRow
  actual_unit_count: number
  status_breakdown: Record<UnitStatus, number>
  counts_match: boolean
  expected_shortfall: number
  over_shipment_count: number
  exceeds_tolerance: boolean
  issues: string[]
}

/**
 * Validate a manufacturing batch against current unit records.
 * Exactly one of batchId or batchNumber must be provided.
 */
export async function validateBatch(
  input: ValidateBatchInput,
): Promise<ValidateBatchResult | null> {
  const hasBatchId = !!input.batchId?.trim()
  const hasBatchNumber = !!input.batchNumber?.trim()

  if (hasBatchId === hasBatchNumber) {
    throw new ApiRequestError(
      '[GTG] validateBatch(): provide exactly one of batchId or batchNumber.',
      'VALIDATION_ERROR',
    )
  }

  const client = getTableClient()
  const batchesTable = 'manufacturing_batches' as never
  const unitsTable = 'serialized_units' as never

  const batchQuery = client
    .from(batchesTable)
    .select(
      'id,batch_number,product_id,sku,license_body,expected_unit_count,received_unit_count,purchase_order_number,notes,received_at',
    )

  const { data: batchData, error: batchError } = input.batchId
    ? await batchQuery.eq('id', input.batchId.trim()).maybeSingle()
    : await batchQuery.eq('batch_number', input.batchNumber!.trim()).maybeSingle()

  if (batchError) {
    throw new ApiRequestError(
      `[GTG] validateBatch(): batch lookup failed: ${batchError.message}`,
      'QUERY_ERROR',
    )
  }

  const batch = (batchData ?? null) as ManufacturingBatchRow | null
  if (!batch) return null

  const { data: unitRows, error: unitsError } = await client
    .from(unitsTable)
    .select('status')
    .eq('batch_id', batch.id)

  if (unitsError) {
    throw new ApiRequestError(
      `[GTG] validateBatch(): units lookup failed: ${unitsError.message}`,
      'QUERY_ERROR',
    )
  }

  const rows = (unitRows ?? []) as BatchUnitStatusRow[]
  const status_breakdown: Record<UnitStatus, number> = {
    available: 0, reserved: 0, sold: 0, fraud_locked: 0, returned: 0, voided: 0,
  }
  for (const row of rows) {
    if (row.status in status_breakdown) {
      status_breakdown[row.status as UnitStatus] += 1
    }
  }

  const actualUnitCount = rows.length
  const countsMatch = batch.received_unit_count === actualUnitCount
  const expectedShortfall = Math.max(0, batch.expected_unit_count - actualUnitCount)
  const overShipmentCount = Math.max(0, actualUnitCount - batch.expected_unit_count)
  const toleranceLimit = Math.ceil(batch.expected_unit_count * 1.1)
  const exceedsTolerance = actualUnitCount > toleranceLimit

  const issues: string[] = []
  if (!countsMatch) {
    issues.push(
      `Recorded received_unit_count (${batch.received_unit_count}) does not match actual serialized units (${actualUnitCount}).`,
    )
  }
  if (expectedShortfall > 0) {
    issues.push(`Batch is short by ${expectedShortfall} unit(s) versus expected_unit_count.`)
  }
  if (overShipmentCount > 0) {
    issues.push(`Batch is over by ${overShipmentCount} unit(s) versus expected_unit_count.`)
  }
  if (exceedsTolerance) {
    issues.push(`Actual units (${actualUnitCount}) exceed 10% tolerance limit (${toleranceLimit}).`)
  }

  return {
    batch,
    actual_unit_count: actualUnitCount,
    status_breakdown,
    counts_match: countsMatch,
    expected_shortfall: expectedShortfall,
    over_shipment_count: overShipmentCount,
    exceeds_tolerance: exceedsTolerance,
    issues,
  }
}

// ─── Verify Hologram Serial ───────────────────────────────────────────────────

export interface VerifyHologramSerialResult {
  verified: boolean
  serial_number: string
  sku: string
  product_name: string
  license_body: string
  hologram: Record<string, unknown> | null
  verification_status: string
  received_at: string
  sold_at: string | null
}

export async function verifyHologramSerial(
  serialNumber: string,
): Promise<VerifyHologramSerialResult> {
  if (!serialNumber || typeof serialNumber !== 'string') {
    throw new ApiRequestError(
      '[GTG] verifyHologramSerial(): serialNumber is required.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<VerifyHologramSerialResult>(
    'verify-serial',
    { serial_number: serialNumber.trim() },
    'verifyHologramSerial',
  )
}

// ─── View Unit Status ─────────────────────────────────────────────────────────

export interface ViewUnitStatusInput {
  unit_id?: string
  serial_number?: string
  batch_id?: string
  product_id?: string
  status?: UnitStatus
  limit?: number
  offset?: number
}

export interface ViewUnitStatusResult {
  units: Array<Record<string, unknown>>
  total: number
  limit: number
  offset: number
}

export async function viewUnitStatus(
  input: ViewUnitStatusInput = {},
): Promise<ViewUnitStatusResult> {
  return invokeFunction<ViewUnitStatusResult>(
    'view-unit-status',
    input as Record<string, unknown>,
    'viewUnitStatus',
  )
}

// ─── View Unit History ────────────────────────────────────────────────────────

export interface ViewUnitHistoryInput {
  unit_id?: string
  serial_number?: string
}

export interface ViewUnitHistoryResult {
  unit: Record<string, unknown>
  ledger: Array<Record<string, unknown>>
  fraud_flags: Array<Record<string, unknown>>
  lock_records: Array<Record<string, unknown>>
  commission: Record<string, unknown> | null
}

export async function viewUnitHistory(
  input: ViewUnitHistoryInput,
): Promise<ViewUnitHistoryResult> {
  if (!input.unit_id && !input.serial_number) {
    throw new ApiRequestError(
      '[GTG] viewUnitHistory(): provide unit_id or serial_number.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ViewUnitHistoryResult>(
    'view-unit-history',
    input as Record<string, unknown>,
    'viewUnitHistory',
  )
}

// ─── Get Unit Status ──────────────────────────────────────────────────────────

export interface GetUnitStatusInput {
  unit_id?: string
  serial_number?: string
}

export interface GetUnitStatusResult {
  unit_id: string
  serial_number: string
  sku: string
  product_id: string
  product_name: string
  product_description: string | null
  license_body: string
  royalty_rate: number
  status: string
  hologram: Record<string, unknown> | null
  order_id: string | null
  received_at: string
  sold_at: string | null
  returned_at: string | null
  updated_at: string
  cost_cents?: number
  retail_price_cents?: number | null
  consultant_id?: string | null
  fraud_locked_at?: string | null
  fraud_locked_by?: string | null
  fraud_lock_reason?: string | null
}

export async function getUnitStatus(input: GetUnitStatusInput): Promise<GetUnitStatusResult> {
  if (!input.unit_id && !input.serial_number) {
    throw new ApiRequestError(
      '[GTG] getUnitStatus(): provide unit_id or serial_number.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<GetUnitStatusResult>(
    'get-unit-status',
    input as Record<string, unknown>,
    'getUnitStatus',
  )
}
