export interface RequestBody {
  order_id: string
  internal_source?: string
}

export interface ValidationError {
  code: string
  message: string
}

export type ProcessStep =
  | 'validate_order'
  | 'validate_serialized_units'
  | 'insert_inventory_ledger'
  | 'fetch_consultant_rate'
  | 'calculate_commission'
  | 'insert_commission_ledger'
  | 'fetch_license_rate'
  | 'calculate_royalty'
  | 'insert_royalty_ledger'

export interface ValidateOrderData {
  valid: boolean
  order_id: string
  order_number: string
  errors?: ValidationError[]
}

export interface SerializedUnitStepData {
  valid: boolean
  line_count: number
  error_count: number
  errors?: ValidationError[]
}

export interface StepResult {
  step: ProcessStep
  success: boolean
  order_number?: string
  line_count?: number
  inserted_count?: number
  error_count?: number
  ledger_entry_ids?: string[]
  consultant_id?: string
  commission_tier?: string
  effective_rate?: number
  tax_onboarding_complete?: boolean
  commission_initial_status?: 'earned' | 'held'
  total_retail_cents?: number
  total_commission_cents?: number
  total_royalty_cents?: number
  commission_line_count?: number
  licensed_line_count?: number
  commission_lines?: Array<{
    order_line_id: string
    unit_id: string
    serial_number: string
    sku: string
    product_name: string
    retail_price_cents: number
    royalty_cents: number
    commission_cents: number
  }>
  commission_entries?: Array<{
    order_line_id: string
    unit_id: string
    serial_number: string
    commission_entry_id: string | null
    commission_cents: number
    status: 'earned' | 'held'
    was_created: boolean
    error: string | null
  }>
  created_count?: number
  already_existed_count?: number
  failed_count?: number
  license_rates?: Array<{
    license_body: string
    default_royalty_rate: number
    line_rate_groups: Array<{
      royalty_rate: number
      line_count: number
    }>
    has_rate_mismatch: boolean
    minimum_royalty_cents: number | null
    reporting_period: string
  }>
  royalty_summary?: {
    licensed_line_count: number
    total_gross_sales_cents: number
    total_royalty_cents: number
    by_license_body: Array<{
      license_body: string
      line_count: number
      gross_sales_cents: number
      royalty_cents: number
      stored_royalty_rate: number
      has_rate_mismatch: boolean
    }>
  }
  royalty_entries?: Array<{
    license_body: string
    royalty_entry_id: string | null
    was_created: boolean
    units_sold: number
    royalty_cents: number
    remittance_cents: number
    error: string | null
  }>
  errors?: ValidationError[]
}

export interface ProcessOrderLedgerResponse {
  phase: '5A-5C'
  pipeline: 'processOrderLedger'
  order_id: string
  success: boolean
  status: 'completed' | 'failed'
  failed_step?: ProcessStep
  completed_steps: number
  total_steps: number
  steps: StepResult[]
  errors: ValidationError[]
}

export interface InsertInventoryLedgerData {
  success: boolean
  line_count: number
  inserted_count: number
  error_count: number
  ledger_entry_ids: string[]
  errors?: ValidationError[]
}

export interface ConsultantRateStepData {
  success: boolean
  consultant_id: string
  consultant_name: string
  commission_tier: string
  effective_rate: number
  tax_onboarding_complete: boolean
  commission_initial_status: 'earned' | 'held'
}

export interface CalculateCommissionStepData {
  success: boolean
  line_count: number
  total_retail_cents: number
  total_commission_cents: number
  commission_lines: Array<{
    order_line_id: string
    unit_id: string
    serial_number: string
    sku: string
    product_name: string
    retail_price_cents: number
    royalty_cents: number
    commission_cents: number
  }>
}

export interface InsertCommissionLedgerStepData {
  success: boolean
  total_lines: number
  created: number
  already_existed: number
  failed: number
  total_commission_cents: number
  entries: Array<{
    order_line_id: string
    unit_id: string
    serial_number: string
    commission_entry_id: string | null
    commission_cents: number
    status: 'earned' | 'held'
    was_created: boolean
    error: string | null
  }>
  errors?: ValidationError[]
}

export interface FetchLicenseRateStepData {
  success: boolean
  line_count: number
  licensed_line_count: number
  license_rates: Array<{
    license_holder_id: string
    license_body: string
    legal_name: string
    code: string
    default_royalty_rate: number
    minimum_royalty_cents: number | null
    reporting_period: string
    line_rate_groups: Array<{
      royalty_rate: number
      line_count: number
    }>
    has_rate_mismatch: boolean
  }>
}

export interface CalculateRoyaltyStepData {
  success: boolean
  licensed_line_count: number
  total_gross_sales_cents: number
  total_royalty_cents: number
  by_license_body: Array<{
    license_body: string
    line_count: number
    gross_sales_cents: number
    royalty_cents: number
    stored_royalty_rate: number
    has_rate_mismatch: boolean
  }>
}

export interface InsertRoyaltyLedgerStepData {
  success: boolean
  created: number
  already_existed: number
  failed: number
  entries: Array<{
    license_body: string
    royalty_entry_id: string | null
    was_created: boolean
    units_sold: number
    royalty_cents: number
    remittance_cents: number
    error: string | null
  }>
  errors?: ValidationError[]
}

export interface LicenseHolderRateRow {
  id: string
  license_body: string
  legal_name: string
  code: string
  default_royalty_rate: number
  minimum_royalty_cents: number | null
  reporting_period: string
  rate_effective_date: string
}

export type StepFailureKind = 'execution' | 'precondition' | 'internal'

export interface StepFailure {
  kind: StepFailureKind
  error: ValidationError
  status: 422 | 500
}

export function buildProcessResponse(
  orderId: string,
  steps: StepResult[],
  success: boolean,
  errors: ValidationError[] = [],
): ProcessOrderLedgerResponse {
  const failedStep = steps.find((s) => !s.success)?.step

  return {
    phase: '5A-5C',
    pipeline: 'processOrderLedger',
    order_id: orderId,
    success,
    status: success ? 'completed' : 'failed',
    ...(failedStep ? { failed_step: failedStep } : {}),
    completed_steps: steps.filter((s) => s.success).length,
    total_steps: 9,
    steps,
    errors,
  }
}
