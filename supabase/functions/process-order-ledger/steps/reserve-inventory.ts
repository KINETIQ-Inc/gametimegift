import type { StepResult, ValidationError } from '../contracts.ts'
import { createExecutionFailure } from '../error-model.ts'
import { runValidateSerializedUnitsStep } from './validate.ts'

export interface ReserveInventoryModuleSuccess {
  ok: true
  steps: StepResult[]
}

export interface ReserveInventoryModuleFailure {
  ok: false
  status: 422 | 500
  steps: StepResult[]
  errors: ValidationError[]
}

export async function runReserveInventoryModule(
  req: Request,
  orderId: string,
): Promise<ReserveInventoryModuleSuccess | ReserveInventoryModuleFailure> {
  const result = await runValidateSerializedUnitsStep(req, orderId)

  if (!result.ok) {
    const failure = createExecutionFailure(result.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'validate_serialized_units',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  if (!result.data.valid) {
    const errors = result.data.errors ?? []
    return {
      ok: false,
      status: 422,
      steps: [
        {
          step: 'validate_serialized_units',
          success: false,
          line_count: result.data.line_count,
          error_count: result.data.error_count,
          errors,
        },
      ],
      errors,
    }
  }

  return {
    ok: true,
    steps: [
      {
        step: 'validate_serialized_units',
        success: true,
        line_count: result.data.line_count,
        error_count: 0,
      },
    ],
  }
}
