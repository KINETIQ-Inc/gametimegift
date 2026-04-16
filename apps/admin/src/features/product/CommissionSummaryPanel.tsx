import type { CommissionSummaryConsultantResult } from '@gtg/api'
import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import { toCurrency, type CommissionSummaryFormState } from './types'

interface CommissionSummaryPanelProps {
  form: CommissionSummaryFormState
  result: CommissionSummaryConsultantResult | null
  submitting: boolean
  onFormChange: (next: CommissionSummaryFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function CommissionSummaryPanel(props: CommissionSummaryPanelProps) {
  const { form, result, submitting, onFormChange, onSubmit } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Commission Summary</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Consultant ID
          <input
            required
            value={form.consultantId}
            onChange={(e) => onFormChange({ ...form, consultantId: e.target.value })}
            placeholder="Consultant profile UUID"
          />
        </label>
        <label>
          From Date
          <input
            type="date"
            value={form.fromDate}
            onChange={(e) => onFormChange({ ...form, fromDate: e.target.value })}
          />
        </label>
        <label>
          To Date
          <input
            type="date"
            value={form.toDate}
            onChange={(e) => onFormChange({ ...form, toDate: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Loading...' : 'Load Summary'}
        </Button>
      </form>

      {result ? (
        <div className="upload-summary">
          <Heading as="h3" display={false}>
            {result.display_name} ({result.commission_tier})
          </Heading>
          <p>
            Lifetime gross: <strong>{toCurrency(result.profile_totals.lifetime_gross_sales_cents)}</strong> |
            Lifetime commissions:{' '}
            <strong>{toCurrency(result.profile_totals.lifetime_commissions_cents)}</strong> | Pending payout:{' '}
            <strong>{toCurrency(result.profile_totals.pending_payout_cents)}</strong>
          </p>
          <p>
            Status totals: earned {toCurrency(result.by_status.earned.total_cents)} ({result.by_status.earned.count}),
            held {toCurrency(result.by_status.held.total_cents)} ({result.by_status.held.count}), approved{' '}
            {toCurrency(result.by_status.approved.total_cents)} ({result.by_status.approved.count}), paid{' '}
            {toCurrency(result.by_status.paid.total_cents)} ({result.by_status.paid.count})
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Serial</th>
                  <th>SKU</th>
                  <th>Status</th>
                  <th>Retail</th>
                  <th>Commission</th>
                </tr>
              </thead>
              <tbody>
                {result.recent_entries.map((entry) => (
                  <tr key={entry.commission_entry_id}>
                    <td>{new Date(entry.created_at).toLocaleDateString()}</td>
                    <td>{entry.serial_number}</td>
                    <td>{entry.sku}</td>
                    <td>{entry.status}</td>
                    <td>{toCurrency(entry.retail_price_cents)}</td>
                    <td>{toCurrency(entry.commission_cents)}</td>
                  </tr>
                ))}
                {result.recent_entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty">
                      No commission entries found for this query.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}
