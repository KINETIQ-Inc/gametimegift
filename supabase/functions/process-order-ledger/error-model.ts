import type { ProcessStep, StepFailure, StepFailureKind, StepResult, ValidationError } from './contracts.ts'

export function createStepFailure(
  kind: StepFailureKind,
  code: string,
  message: string,
): StepFailure {
  const status: 422 | 500 = kind === 'execution' || kind === 'internal' ? 500 : 422

  return {
    kind,
    status,
    error: { code, message },
  }
}

export function createExecutionFailure(message: string): StepFailure {
  return createStepFailure('execution', 'STEP_EXECUTION_FAILED', message)
}

export function createKindedFailure(kind: 'precondition' | 'internal', message: string): StepFailure {
  return createStepFailure(kind, 'STEP_EXECUTION_FAILED', message)
}

export function createFailedStep(step: ProcessStep, errors: ValidationError[]): StepResult {
  return {
    step,
    success: false,
    errors,
    error_count: errors.length,
  }
}
