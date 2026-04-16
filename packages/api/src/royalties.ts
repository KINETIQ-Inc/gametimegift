import { ApiRequestError } from './error'
import { invokeFunction, invokeFunctionWithHeaders } from './transport'

export interface RoyaltyRateGroup {
  royalty_rate: number
  unit_count: number
  gross_sales_cents: number
  royalty_cents: number
}

export interface RoyaltySummaryItem {
  license_body: string
  license_holder_id: string
  license_holder_name: string
  license_holder_code: string
  reporting_period: string
  default_royalty_rate: number
  minimum_royalty_cents: number | null
  units_sold: number
  gross_sales_cents: number
  royalty_cents: number
  remittance_cents: number
  minimum_applied: boolean
  has_rate_mismatch: boolean
  rate_groups: RoyaltyRateGroup[]
  ledger_entry_ids: string[]
  existing_entry_id: string | null
}

export interface RoyaltySummaryResult {
  year_month: string
  period_start: string
  period_end: string
  royalties: RoyaltySummaryItem[]
}

export type RoyaltyReportLicenseBody = 'CLC' | 'ARMY'

export interface RoyaltyReportMetadata {
  generated_at: string
  license_body: RoyaltyReportLicenseBody
  period_start: string
  period_end: string
  reporting_period: string
}

export interface RoyaltyReportLicensor {
  id: string
  legal_name: string
  code: string
  contact_name: string
  contact_email: string
  default_royalty_rate: number
  minimum_royalty_cents: number | null
  reporting_period: string
  rate_effective_date: string
  rate_expiry_date: string | null
}

export interface RoyaltyReportEntry {
  id: string
  units_sold: number
  gross_sales_cents: number
  royalty_rate: number
  royalty_cents: number
  remittance_cents: number
  minimum_applied: boolean
  status: string
  licensor_reference_id: string | null
  submitted_at: string | null
  submitted_by: string | null
  paid_at: string | null
  payment_reference: string | null
  dispute_note: string | null
  resolution_note: string | null
  adjusted_remittance_cents: number | null
  created_at: string
  updated_at: string
}

export interface RoyaltyReportUnitSale {
  ledger_entry_id: string
  unit_id: string
  serial_number: string
  sku: string
  product_name: string
  retail_price_cents: number | null
  royalty_rate: number
  royalty_cents: number | null
  occurred_at: string
}

export interface RoyaltyReportActiveLock {
  id: string
  scope: string
  target_id: string
  target_label: string
  lock_reason: string
  licensor_reference_id: string | null
  locked_at: string
}

export interface RoyaltyReportResult {
  report: RoyaltyReportMetadata
  licensor: RoyaltyReportLicensor
  royalty_entry: RoyaltyReportEntry
  unit_sales: RoyaltyReportUnitSale[]
  active_locks: RoyaltyReportActiveLock[]
}

export interface ExportRoyaltyCsvInput {
  licenseBody: RoyaltyReportLicenseBody
  yearMonth: string
}

export interface ExportRoyaltyCsvResult {
  filename: string
  csv: string
}

function assertValidYearMonth(yearMonth: string, fnName: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): yearMonth must be in YYYY-MM format.`,
      'VALIDATION_ERROR',
    )
  }
}

function assertValidLicenseBody(
  licenseBody: string,
  fnName: string,
): asserts licenseBody is RoyaltyReportLicenseBody {
  if (licenseBody !== 'CLC' && licenseBody !== 'ARMY') {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): licenseBody must be either 'CLC' or 'ARMY'.`,
      'VALIDATION_ERROR',
    )
  }
}

export async function getRoyaltySummary(yearMonth: string): Promise<RoyaltySummaryResult> {
  assertValidYearMonth(yearMonth, 'getRoyaltySummary')
  return invokeFunction<RoyaltySummaryResult>(
    'calculate-royalties-owed',
    { year_month: yearMonth },
    'getRoyaltySummary',
  )
}

export async function getClcRoyaltyReport(yearMonth: string): Promise<RoyaltyReportResult> {
  assertValidYearMonth(yearMonth, 'getClcRoyaltyReport')
  return invokeFunction<RoyaltyReportResult>(
    'generate-clc-report',
    { year_month: yearMonth },
    'getClcRoyaltyReport',
  )
}

export async function getArmyRoyaltyReport(yearMonth: string): Promise<RoyaltyReportResult> {
  assertValidYearMonth(yearMonth, 'getArmyRoyaltyReport')
  return invokeFunction<RoyaltyReportResult>(
    'generate-army-report',
    { year_month: yearMonth },
    'getArmyRoyaltyReport',
  )
}

function decodeCsvPayload(
  data: Blob | string | ArrayBuffer | Uint8Array | null,
): Promise<string> | string {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  throw new ApiRequestError(
    '[GTG] exportRoyaltyCsv(): function returned an unsupported CSV payload.',
    'EMPTY_RESPONSE',
  )
}

export async function exportRoyaltyCsv(
  input: ExportRoyaltyCsvInput,
): Promise<ExportRoyaltyCsvResult> {
  assertValidLicenseBody(input.licenseBody, 'exportRoyaltyCsv')
  assertValidYearMonth(input.yearMonth, 'exportRoyaltyCsv')

  const data = await invokeFunctionWithHeaders<Blob | string | ArrayBuffer | Uint8Array>(
    'export-royalty-csv',
    { license_body: input.licenseBody, year_month: input.yearMonth },
    { Accept: 'text/csv' },
    'exportRoyaltyCsv',
  )

  const csv = await decodeCsvPayload(data)
  return {
    filename: `GTG-${input.licenseBody}-${input.yearMonth}-royalty.csv`,
    csv,
  }
}
