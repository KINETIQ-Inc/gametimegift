import type { StepResult, ValidationError } from '../contracts.ts'
import { createKindedFailure } from '../error-model.ts'
import {
  runCalculateCommissionStep,
  runFetchConsultantRateStep,
  runInsertCommissionLedgerStep,
} from './commission.ts'

export interface ComputeCommissionModuleSuccess {
  ok: true
  steps: StepResult[]
}

export interface ComputeCommissionModuleFailure {
  ok: false
  status: 422 | 500
  steps: StepResult[]
  errors: ValidationError[]
}

export async function runComputeCommissionModule(
  orderId: string,
): Promise<ComputeCommissionModuleSuccess | ComputeCommissionModuleFailure> {
  const consultantRate = await runFetchConsultantRateStep(orderId)

  if (!consultantRate.ok) {
    if (
      consultantRate.kind === 'precondition' &&
      consultantRate.error.includes("expected 'consultant_assisted'")
    ) {
      return {
        ok: true,
        steps: [
          {
            step: 'fetch_consultant_rate',
            success: true,
            commission_line_count: 0,
            total_commission_cents: 0,
            error_count: 0,
          },
          {
            step: 'calculate_commission',
            success: true,
            commission_line_count: 0,
            total_retail_cents: 0,
            total_commission_cents: 0,
            commission_lines: [],
            error_count: 0,
          },
          {
            step: 'insert_commission_ledger',
            success: true,
            commission_line_count: 0,
            total_commission_cents: 0,
            commission_entries: [],
            created_count: 0,
            already_existed_count: 0,
            failed_count: 0,
            error_count: 0,
          },
        ],
      }
    }

    const failure = createKindedFailure(consultantRate.kind, consultantRate.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_consultant_rate',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const commission = await runCalculateCommissionStep(orderId, consultantRate.data.effective_rate)

  if (!commission.ok) {
    const failure = createKindedFailure(commission.kind, commission.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_consultant_rate',
          success: true,
          consultant_id: consultantRate.data.consultant_id,
          commission_tier: consultantRate.data.commission_tier,
          effective_rate: consultantRate.data.effective_rate,
          tax_onboarding_complete: consultantRate.data.tax_onboarding_complete,
          commission_initial_status: consultantRate.data.commission_initial_status,
          error_count: 0,
        },
        {
          step: 'calculate_commission',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const commissionInsert = await runInsertCommissionLedgerStep(
    orderId,
    consultantRate.data.consultant_id,
    consultantRate.data.consultant_name,
    consultantRate.data.commission_tier,
    consultantRate.data.effective_rate,
    consultantRate.data.commission_initial_status,
    commission.data.commission_lines,
  )

  if (!commissionInsert.ok) {
    const failure = createKindedFailure(commissionInsert.kind, commissionInsert.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'fetch_consultant_rate',
          success: true,
          consultant_id: consultantRate.data.consultant_id,
          commission_tier: consultantRate.data.commission_tier,
          effective_rate: consultantRate.data.effective_rate,
          tax_onboarding_complete: consultantRate.data.tax_onboarding_complete,
          commission_initial_status: consultantRate.data.commission_initial_status,
          error_count: 0,
        },
        {
          step: 'calculate_commission',
          success: true,
          commission_line_count: commission.data.line_count,
          total_retail_cents: commission.data.total_retail_cents,
          total_commission_cents: commission.data.total_commission_cents,
          commission_lines: commission.data.commission_lines,
          error_count: 0,
        },
        {
          step: 'insert_commission_ledger',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  const insertErrors = commissionInsert.data.errors ?? []
  if (!commissionInsert.data.success) {
    return {
      ok: false,
      status: 422,
      steps: [
        {
          step: 'fetch_consultant_rate',
          success: true,
          consultant_id: consultantRate.data.consultant_id,
          commission_tier: consultantRate.data.commission_tier,
          effective_rate: consultantRate.data.effective_rate,
          tax_onboarding_complete: consultantRate.data.tax_onboarding_complete,
          commission_initial_status: consultantRate.data.commission_initial_status,
          error_count: 0,
        },
        {
          step: 'calculate_commission',
          success: true,
          commission_line_count: commission.data.line_count,
          total_retail_cents: commission.data.total_retail_cents,
          total_commission_cents: commission.data.total_commission_cents,
          commission_lines: commission.data.commission_lines,
          error_count: 0,
        },
        {
          step: 'insert_commission_ledger',
          success: false,
          commission_line_count: commissionInsert.data.total_lines,
          total_commission_cents: commissionInsert.data.total_commission_cents,
          commission_entries: commissionInsert.data.entries,
          created_count: commissionInsert.data.created,
          already_existed_count: commissionInsert.data.already_existed,
          failed_count: commissionInsert.data.failed,
          error_count: commissionInsert.data.failed,
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
        step: 'fetch_consultant_rate',
        success: true,
        consultant_id: consultantRate.data.consultant_id,
        commission_tier: consultantRate.data.commission_tier,
        effective_rate: consultantRate.data.effective_rate,
        tax_onboarding_complete: consultantRate.data.tax_onboarding_complete,
        commission_initial_status: consultantRate.data.commission_initial_status,
        error_count: 0,
      },
      {
        step: 'calculate_commission',
        success: true,
        commission_line_count: commission.data.line_count,
        total_retail_cents: commission.data.total_retail_cents,
        total_commission_cents: commission.data.total_commission_cents,
        commission_lines: commission.data.commission_lines,
        error_count: 0,
      },
      {
        step: 'insert_commission_ledger',
        success: true,
        commission_line_count: commissionInsert.data.total_lines,
        total_commission_cents: commissionInsert.data.total_commission_cents,
        commission_entries: commissionInsert.data.entries,
        created_count: commissionInsert.data.created,
        already_existed_count: commissionInsert.data.already_existed,
        failed_count: commissionInsert.data.failed,
        error_count: 0,
      },
    ],
  }
}
