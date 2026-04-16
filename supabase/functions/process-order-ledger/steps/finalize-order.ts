import { buildProcessResponse, type StepResult, type ValidationError } from '../contracts.ts'

export function buildFinalSuccessResponse(orderId: string, steps: StepResult[]) {
  return buildProcessResponse(orderId, steps, true)
}

export function buildFinalFailureResponse(
  orderId: string,
  steps: StepResult[],
  errors: ValidationError[],
) {
  return buildProcessResponse(orderId, steps, false, errors)
}
