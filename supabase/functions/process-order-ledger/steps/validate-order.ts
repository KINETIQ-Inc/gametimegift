import type { RequestBody, StepResult, ValidationError } from '../contracts.ts'
import { createExecutionFailure } from '../error-model.ts'
import {
  runValidateOrderStep,
  runValidateOrderStepInternal,
} from './validate.ts'

export interface ValidateOrderModuleSuccess {
  ok: true
  steps: StepResult[]
  order_number: string
}

export interface ValidateOrderModuleFailure {
  ok: false
  status: 422 | 500
  steps: StepResult[]
  errors: ValidationError[]
}

export async function runValidateOrderModule(
  req: Request,
  body: RequestBody,
  internalWebhookCall: boolean,
): Promise<ValidateOrderModuleSuccess | ValidateOrderModuleFailure> {
  const result = internalWebhookCall
    ? await runValidateOrderStepInternal(body.order_id)
    : await runValidateOrderStep(req, body.order_id)

  if (!result.ok) {
    const failure = createExecutionFailure(result.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'validate_order',
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
          step: 'validate_order',
          success: false,
          order_number: result.data.order_number,
          error_count: errors.length,
          errors,
        },
      ],
      errors,
    }
  }

  return {
    ok: true,
    order_number: result.data.order_number,
    steps: [
      {
        step: 'validate_order',
        success: true,
        order_number: result.data.order_number,
      },
    ],
  }
}
