import type { RoyaltyReportResult, RoyaltySummaryResult } from '@gtg/api'
import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import { toCurrency, type RoyaltySummaryFormState } from './types'

interface RoyaltySummaryPanelProps {
  form: RoyaltySummaryFormState
  result: RoyaltySummaryResult | null
  clcReport: RoyaltyReportResult | null
  armyReport: RoyaltyReportResult | null
  submitting: boolean
  reportLoading: 'CLC' | 'ARMY' | null
  csvLoading: 'CLC' | 'ARMY' | null
  onFormChange: (next: RoyaltySummaryFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onGenerateClcReport: () => void
  onGenerateArmyReport: () => void
  onExportCsv: (licenseBody: 'CLC' | 'ARMY') => void
}

function ReportSnapshot({
  title,
  report,
}: {
  title: string
  report: RoyaltyReportResult
}) {
  return (
    <article className="report-card">
      <Heading as="h3" display={false}>{title}</Heading>
      <p>
        {report.licensor.legal_name} | {report.report.period_start} to {report.report.period_end}
      </p>
      <p>
        Remittance <strong>{toCurrency(report.royalty_entry.remittance_cents)}</strong> | Units{' '}
        <strong>{report.royalty_entry.units_sold}</strong> | Locks{' '}
        <strong>{report.active_locks.length}</strong>
      </p>
      <p>
        Status <strong>{report.royalty_entry.status}</strong> | Unit detail rows{' '}
        <strong>{report.unit_sales.length}</strong>
      </p>
    </article>
  )
}

export function RoyaltySummaryPanel(props: RoyaltySummaryPanelProps) {
  const {
    form,
    result,
    clcReport,
    armyReport,
    submitting,
    reportLoading,
    csvLoading,
    onFormChange,
    onSubmit,
    onGenerateClcReport,
    onGenerateArmyReport,
    onExportCsv,
  } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Royalty Summary</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Month
          <input
            required
            type="month"
            value={form.yearMonth}
            onChange={(e) => onFormChange({ ...form, yearMonth: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Loading...' : 'Load Summary'}
        </Button>
      </form>

      <div className="report-actions">
        <Button
          variant="secondary"
          disabled={submitting || reportLoading !== null}
          onClick={onGenerateClcReport}
        >
          {reportLoading === 'CLC' ? 'Loading CLC...' : 'Load CLC Report'}
        </Button>
        <Button
          variant="secondary"
          disabled={submitting || reportLoading !== null}
          onClick={onGenerateArmyReport}
        >
          {reportLoading === 'ARMY' ? 'Loading Army...' : 'Load Army Report'}
        </Button>
        <Button
          variant="ghost"
          disabled={submitting || csvLoading !== null}
          onClick={() => onExportCsv('CLC')}
        >
          {csvLoading === 'CLC' ? 'Exporting CLC...' : 'Export CLC CSV'}
        </Button>
        <Button
          variant="ghost"
          disabled={submitting || csvLoading !== null}
          onClick={() => onExportCsv('ARMY')}
        >
          {csvLoading === 'ARMY' ? 'Exporting Army...' : 'Export Army CSV'}
        </Button>
      </div>

      {result ? (
        <div className="upload-summary">
          <Heading as="h3" display={false}>
            Period {result.period_start} to {result.period_end}
          </Heading>
          <p>
            Total remittance:{' '}
            <strong>
              {toCurrency(result.royalties.reduce((sum, row) => sum + row.remittance_cents, 0))}
            </strong>{' '}
            | Units sold: <strong>{result.royalties.reduce((sum, row) => sum + row.units_sold, 0)}</strong>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Licensor</th>
                  <th>Body</th>
                  <th>Units</th>
                  <th>Gross</th>
                  <th>Royalty</th>
                  <th>Remittance</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {result.royalties.map((row) => (
                  <tr key={`${row.license_body}-${row.license_holder_id}`}>
                    <td>{row.license_holder_name}</td>
                    <td>{row.license_body}</td>
                    <td>{row.units_sold}</td>
                    <td>{toCurrency(row.gross_sales_cents)}</td>
                    <td>{toCurrency(row.royalty_cents)}</td>
                    <td>{toCurrency(row.remittance_cents)}</td>
                    <td>
                      {row.minimum_applied ? 'min floor' : 'none'}
                      {row.has_rate_mismatch ? ' + rate mismatch' : ''}
                    </td>
                  </tr>
                ))}
                {result.royalties.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="empty">
                      No royalty rows for this month.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {clcReport || armyReport ? (
        <div className="report-grid">
          {clcReport ? <ReportSnapshot title="CLC Compliance Report" report={clcReport} /> : null}
          {armyReport ? <ReportSnapshot title="Army Compliance Report" report={armyReport} /> : null}
        </div>
      ) : null}
    </section>
  )
}
