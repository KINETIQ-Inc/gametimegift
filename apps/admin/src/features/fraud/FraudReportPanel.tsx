/**
 * FraudReportPanel — fraud event queue with status/severity filters.
 *
 * Loads and displays FraudEventListItem rows from viewFraudEvents().
 * Filters: status (open | under_review | resolved | dismissed | escalated)
 *          severity (low | medium | high | critical)
 *          limit (10 | 25 | 50 | 100)
 *
 * Each row shows the key fields an investigator needs at a glance:
 *   serial, source, severity, status, description, auto_locked, created_at.
 *
 * ROLE: fraud:view_reports (SUPER_ADMIN, FRAUD_INVESTIGATOR)
 */

import type { FormEvent } from 'react'
import { Button, EmptyState, SectionIntro } from '@gtg/ui'
import type { FraudEventListItem, ViewFraudEventsResult } from '../../services/admin-service'
import type { FraudReportFormState } from '../product/types'

export interface FraudReportPanelProps {
  form: FraudReportFormState
  result: ViewFraudEventsResult | null
  submitting: boolean
  onFormChange: (form: FraudReportFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under review' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed' },
]

const SEVERITY_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

const LIMIT_OPTIONS = ['10', '25', '50', '100']

function severityClass(severity: FraudEventListItem['severity']): string {
  switch (severity) {
    case 'critical':
      return 'fraud-severity-critical'
    case 'high':
      return 'fraud-severity-high'
    case 'medium':
      return 'fraud-severity-medium'
    default:
      return 'fraud-severity-low'
  }
}

function statusClass(status: FraudEventListItem['status']): string {
  switch (status) {
    case 'open':
      return 'fraud-status-open'
    case 'under_review':
      return 'fraud-status-review'
    case 'escalated':
      return 'fraud-status-escalated'
    case 'confirmed':
      return 'fraud-status-resolved'
    default:
      return 'fraud-status-dismissed'
  }
}

export function FraudReportPanel({
  form,
  result,
  submitting,
  onFormChange,
  onSubmit,
}: FraudReportPanelProps) {
  return (
    <section className="panel fraud-report-panel">
      <SectionIntro
        className="panel-head"
        eyebrow="Fraud Reports"
        title="Review flagged units."
        description={
          <p>
            Query the fraud event queue by status and severity. Each flag represents a unit that
            has been automatically or manually flagged. <code>admin_manual</code> flags are
            created by the Lock Unit tool above. High or critical flags trigger an automatic unit
            lock.
          </p>
        }
      />

      <form className="admin-form fraud-report-filters" onSubmit={onSubmit}>
        <label>
          Status
          <select
            value={form.status}
            onChange={(e) => onFormChange({ ...form, status: e.target.value })}
            disabled={submitting}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Severity
          <select
            value={form.severity}
            onChange={(e) => onFormChange({ ...form, severity: e.target.value })}
            disabled={submitting}
          >
            {SEVERITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Limit
          <select
            value={form.limit}
            onChange={(e) => onFormChange({ ...form, limit: e.target.value })}
            disabled={submitting}
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
        </label>

        <Button type="submit" variant="secondary" disabled={submitting}>
          {submitting ? 'Loading…' : 'Load Events'}
        </Button>
      </form>

      {result ? (
        <div className="fraud-report-result">
          <p className="fraud-report-count">
            Showing {result.flags.length} of {result.total} flag{result.total !== 1 ? 's' : ''}
          </p>

          {result.flags.length === 0 ? (
            <EmptyState
              className="fraud-report-empty"
              title="No fraud flags match the selected filters."
              description="Try widening the status or severity filters to review more events."
            />
          ) : (
            <div className="fraud-event-list">
              {result.flags.map((flag) => (
                <div key={flag.id} className="fraud-event-row">
                  <div className="fraud-event-head">
                    <span className="fraud-event-serial">{flag.serial_number}</span>
                    <span className={`fraud-badge ${severityClass(flag.severity)}`}>
                      {flag.severity}
                    </span>
                    <span className={`fraud-badge ${statusClass(flag.status)}`}>
                      {flag.status.replace('_', ' ')}
                    </span>
                    {flag.auto_locked ? (
                      <span className="fraud-badge fraud-badge-locked">auto-locked</span>
                    ) : null}
                  </div>

                  <dl className="fraud-event-detail">
                    <div>
                      <dt>Flag ID</dt>
                      <dd className="mono">{flag.id}</dd>
                    </div>
                    <div>
                      <dt>SKU</dt>
                      <dd>{flag.sku}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{flag.source}</dd>
                    </div>
                    <div>
                      <dt>Description</dt>
                      <dd>{flag.description}</dd>
                    </div>
                    {flag.related_order_id ? (
                      <div>
                        <dt>Order</dt>
                        <dd className="mono">{flag.related_order_id}</dd>
                      </div>
                    ) : null}
                    {flag.reporting_licensor ? (
                      <div>
                        <dt>Licensor</dt>
                        <dd>{flag.reporting_licensor}</dd>
                      </div>
                    ) : null}
                    {flag.assigned_to ? (
                      <div>
                        <dt>Assigned to</dt>
                        <dd className="mono">{flag.assigned_to}</dd>
                      </div>
                    ) : null}
                    {flag.escalation_reason ? (
                      <div>
                        <dt>Escalation reason</dt>
                        <dd>{flag.escalation_reason}</dd>
                      </div>
                    ) : null}
                    {flag.resolution_note ? (
                      <div>
                        <dt>Resolution note</dt>
                        <dd>{flag.resolution_note}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Raised at</dt>
                      <dd>{flag.created_at}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}
