import type { ValidateBatchResult } from '@gtg/api'
import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import type { BatchValidationFormState } from './types'

interface BatchValidationPanelProps {
  form: BatchValidationFormState
  result: ValidateBatchResult | null
  submitting: boolean
  onFormChange: (next: BatchValidationFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function BatchValidationPanel(props: BatchValidationPanelProps) {
  const { form, result, submitting, onFormChange, onSubmit } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Batch Validation</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Batch Number
          <input
            required
            value={form.batchNumber}
            onChange={(e) => onFormChange({ ...form, batchNumber: e.target.value })}
            placeholder="BATCH-20260307-CLC-001"
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Validating...' : 'Validate Batch'}
        </Button>
      </form>

      {result ? (
        <div className="upload-summary">
          <Heading as="h3" display={false}>Validation Result: {result.batch.batch_number}</Heading>
          <p>
            Expected: <strong>{result.batch.expected_unit_count}</strong> | Recorded received:{' '}
            <strong>{result.batch.received_unit_count}</strong> | Actual units:{' '}
            <strong>{result.actual_unit_count}</strong>
          </p>
          <p>
            Count match: <strong>{result.counts_match ? 'yes' : 'no'}</strong> | Shortfall:{' '}
            <strong>{result.expected_shortfall}</strong> | Over-shipment:{' '}
            <strong>{result.over_shipment_count}</strong>
          </p>
          <p>
            Tolerance exceeded: <strong>{result.exceeds_tolerance ? 'yes' : 'no'}</strong>
          </p>
          <p>
            Statuses: available {result.status_breakdown.available}, reserved{' '}
            {result.status_breakdown.reserved}, sold {result.status_breakdown.sold}, fraud_locked{' '}
            {result.status_breakdown.fraud_locked}, returned {result.status_breakdown.returned},
            voided {result.status_breakdown.voided}
          </p>
          {result.issues.length > 0 ? (
            <ul className="issues">
              {result.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p>No structural issues detected.</p>
          )}
        </div>
      ) : null}
    </section>
  )
}
