import type { StepResult, ValidationError } from '../contracts.ts'
import { createKindedFailure } from '../error-model.ts'
import {
  runCalculateRoyaltyStep,
  runFetchLicenseRateStep,
  runInsertRoyaltyLedgerStep,
} from './royalty.ts'

export interface ApplyRoyaltyModuleSuccess {
  ok: true
  steps: StepResult[]
}

export interface ApplyRoyaltyModuleFailure {
  ok: false
  status: 422 | 500
  steps: StepResult[]
  errors: ValidationError[]
}

export async function runApplyRoyaltyModule(
  orderId: string,
  performedBy: string,
  inventoryLedgerEntryIds: string[],
): Promise<ApplyRoyaltyModuleSuccess | ApplyRoyaltyModuleFailure> {
  const licenseRate = await runFetchLicenseRateStep(orderId)

  if (!licenseRate.ok) {
    const failure = createKindedFailure(licenseRate.kind, licenseRate.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_license_rate',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const royalty = await runCalculateRoyaltyStep(orderId, licenseRate.data.license_rates)

  if (!royalty.ok) {
    const failure = createKindedFailure(royalty.kind, royalty.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_license_rate',
          success: true,
          line_count: licenseRate.data.line_count,
          licensed_line_count: licenseRate.data.licensed_line_count,
          license_rates: licenseRate.data.license_rates.map((r) => ({
            license_body: r.license_body,
            default_royalty_rate: r.default_royalty_rate,
            line_rate_groups: r.line_rate_groups,
            has_rate_mismatch: r.has_rate_mismatch,
            minimum_royalty_cents: r.minimum_royalty_cents,
            reporting_period: r.reporting_period,
          })),
          error_count: 0,
        },
        {
          step: 'calculate_royalty',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const royaltyInsert = await runInsertRoyaltyLedgerStep(
    performedBy,
    inventoryLedgerEntryIds,
    licenseRate.data.license_rates,
    royalty.data.by_license_body,
  )

  if (!royaltyInsert.ok) {
    const failure = createKindedFailure(royaltyInsert.kind, royaltyInsert.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_license_rate',
          success: true,
          line_count: licenseRate.data.line_count,
          licensed_line_count: licenseRate.data.licensed_line_count,
          license_rates: licenseRate.data.license_rates.map((r) => ({
            license_body: r.license_body,
            default_royalty_rate: r.default_royalty_rate,
            line_rate_groups: r.line_rate_groups,
            has_rate_mismatch: r.has_rate_mismatch,
            minimum_royalty_cents: r.minimum_royalty_cents,
            reporting_period: r.reporting_period,
          })),
          error_count: 0,
        },
        {
          step: 'calculate_royalty',
          success: true,
          licensed_line_count: royalty.data.licensed_line_count,
          total_retail_cents: royalty.data.total_gross_sales_cents,
          total_royalty_cents: royalty.data.total_royalty_cents,
          royalty_summary: {
            licensed_line_count: royalty.data.licensed_line_count,
            total_gross_sales_cents: royalty.data.total_gross_sales_cents,
            total_royalty_cents: royalty.data.total_royalty_cents,
            by_license_body: royalty.data.by_license_body,
          },
          error_count: 0,
        },
        {
          step: 'insert_royalty_ledger',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const insertErrors = royaltyInsert.data.errors ?? []
  if (!royaltyInsert.data.success) {
    return {
      ok: false,
      status: 422,
      steps: [
        {
          step: 'fetch_license_rate',
          success: true,
          line_count: licenseRate.data.line_count,
          licensed_line_count: licenseRate.data.licensed_line_count,
          license_rates: licenseRate.data.license_rates.map((r) => ({
            license_body: r.license_body,
            default_royalty_rate: r.default_royalty_rate,
            line_rate_groups: r.line_rate_groups,
            has_rate_mismatch: r.has_rate_mismatch,
            minimum_royalty_cents: r.minimum_royalty_cents,
            reporting_period: r.reporting_period,
          })),
          error_count: 0,
        },
        {
          step: 'calculate_royalty',
          success: true,
          licensed_line_count: royalty.data.licensed_line_count,
          total_retail_cents: royalty.data.total_gross_sales_cents,
          total_royalty_cents: royalty.data.total_royalty_cents,
          royalty_summary: {
            licensed_line_count: royalty.data.licensed_line_count,
            total_gross_sales_cents: royalty.data.total_gross_sales_cents,
            total_royalty_cents: royalty.data.total_royalty_cents,
            by_license_body: royalty.data.by_license_body,
          },
          error_count: 0,
        },
        {
          step: 'insert_royalty_ledger',
          success: false,
          royalty_entries: royaltyInsert.data.entries,
          created_count: royaltyInsert.data.created,
          already_existed_count: royaltyInsert.data.already_existed,
          failed_count: royaltyInsert.data.failed,
          error_count: royaltyInsert.data.failed,
          errors: insertErrors,
        },
      ],
      errors: insertErrors,
    }
  }

  return {
    ok: true,
    steps: [
      {
        step: 'fetch_license_rate',
        success: true,
        line_count: licenseRate.data.line_count,
        licensed_line_count: licenseRate.data.licensed_line_count,
        license_rates: licenseRate.data.license_rates.map((r) => ({
          license_body: r.license_body,
          default_royalty_rate: r.default_royalty_rate,
          line_rate_groups: r.line_rate_groups,
          has_rate_mismatch: r.has_rate_mismatch,
          minimum_royalty_cents: r.minimum_royalty_cents,
          reporting_period: r.reporting_period,
        })),
        error_count: 0,
      },
      {
        step: 'calculate_royalty',
        success: true,
        licensed_line_count: royalty.data.licensed_line_count,
        total_retail_cents: royalty.data.total_gross_sales_cents,
        total_royalty_cents: royalty.data.total_royalty_cents,
        royalty_summary: {
          licensed_line_count: royalty.data.licensed_line_count,
          total_gross_sales_cents: royalty.data.total_gross_sales_cents,
          total_royalty_cents: royalty.data.total_royalty_cents,
          by_license_body: royalty.data.by_license_body,
        },
        error_count: 0,
      },
      {
        step: 'insert_royalty_ledger',
        success: true,
        royalty_entries: royaltyInsert.data.entries,
        created_count: royaltyInsert.data.created,
        already_existed_count: royaltyInsert.data.already_existed,
        failed_count: royaltyInsert.data.failed,
        error_count: 0,
      },
    ],
  }
}
