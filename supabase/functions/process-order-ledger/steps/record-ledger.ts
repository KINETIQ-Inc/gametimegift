import type { StepResult, ValidationError } from '../contracts.ts'
import { createExecutionFailure } from '../error-model.ts'
import { runInsertInventoryLedgerStep } from './inventory.ts'

export interface RecordLedgerModuleSuccess {
  ok: true
  steps: StepResult[]
  inventory_ledger_entry_ids: string[]
}

export interface RecordLedgerModuleFailure {
  ok: false
  status: 422 | 500
  steps: StepResult[]
  errors: ValidationError[]
}

export async function runRecordLedgerModule(
  orderId: string,
  performedBy: string,
): Promise<RecordLedgerModuleSuccess | RecordLedgerModuleFailure> {
  const result = await runInsertInventoryLedgerStep(orderId, performedBy)

  if (!result.ok) {
    const failure = createExecutionFailure(result.error)
    return {
      ok: false,
      status: failure.status,
      steps: [
        {
          step: 'insert_inventory_ledger',
          success: false,
          errors: [failure.error],
          error_count: 1,
        },
      ],
      errors: [failure.error],
    }
  }

  if (!result.data.success) {
    const errors = result.data.errors ?? []
    return {
      ok: false,
      status: 422,
      steps: [
        {
          step: 'insert_inventory_ledger',
          success: false,
          line_count: result.data.line_count,
          inserted_count: result.data.inserted_count,
          error_count: result.data.error_count,
          ledger_entry_ids: result.data.ledger_entry_ids,
          errors,
        },
      ],
      errors,
    }
  }

  return {
    ok: true,
    inventory_ledger_entry_ids: result.data.ledger_entry_ids,
    steps: [
      {
        step: 'insert_inventory_ledger',
        success: true,
        line_count: result.data.line_count,
        inserted_count: result.data.inserted_count,
        error_count: 0,
        ledger_entry_ids: result.data.ledger_entry_ids,
      },
    ],
  }
}
