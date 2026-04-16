/**
 * ConsultantsPage — "/consultants"
 *
 * Browse, filter, and manage consultant accounts.
 * Status transitions (approve, suspend, terminate, reactivate)
 * and tier changes are scoped to the ConsultantDetailModal.
 */

import { type ChangeEvent, useEffect, useState } from 'react'
import {
  approveConsultant,
  assignConsultantCommissionRate,
  isTransientError,
  listConsultants,
  reactivateConsultant,
  suspendConsultant,
  terminateConsultant,
  toUserMessage,
} from '@gtg/api'
import type { CommissionTier, ConsultantStatus } from '@gtg/types'
import { AlertBanner, Badge, Button, EmptyState, Heading, InlineMessage, SectionIntro } from '@gtg/ui'

type ConsultantRow = Awaited<ReturnType<typeof listConsultants>>['consultants'][number]

const STATUS_FILTERS: Array<{ value: ConsultantStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending_approval', label: 'Pending' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'terminated', label: 'Terminated' },
]

const TIER_OPTIONS: CommissionTier[] = ['standard', 'senior', 'elite', 'custom']

function statusBadgeVariant(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'active') return 'success'
  if (status === 'pending_approval') return 'warning'
  if (status === 'suspended' || status === 'terminated') return 'error'
  return 'neutral'
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

export function ConsultantsPage() {
  const [consultants, setConsultants] = useState<ConsultantRow[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<ConsultantStatus | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const [selected, setSelected] = useState<ConsultantRow | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [reasonInput, setReasonInput] = useState('')
  const [tierInput, setTierInput] = useState<CommissionTier>('standard')

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      setRetryable(false)
      try {
        const result = await listConsultants({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          limit: 50,
        })
        if (cancelled) return
        setConsultants(result.consultants)
        setTotal(result.total)
      } catch (err) {
        if (cancelled) return
        setError(toUserMessage(err, 'Failed to load consultants.'))
        if (isTransientError(err)) setRetryable(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [statusFilter, search, refreshKey])

  async function handleApprove(): Promise<void> {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await approveConsultant({ consultantId: selected.id })
      setActionSuccess(`${selected.display_name} approved.`)
      setRefreshKey((k) => k + 1)
      setSelected(null)
    } catch (err) {
      setActionError(toUserMessage(err, 'Approve failed.'))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleSuspend(): Promise<void> {
    if (!selected || !reasonInput.trim()) return
    setActionLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await suspendConsultant({ consultantId: selected.id, reason: reasonInput.trim() })
      setActionSuccess(`${selected.display_name} suspended.`)
      setRefreshKey((k) => k + 1)
      setSelected(null)
      setReasonInput('')
    } catch (err) {
      setActionError(toUserMessage(err, 'Suspend failed.'))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleTerminate(): Promise<void> {
    if (!selected || !reasonInput.trim()) return
    setActionLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await terminateConsultant({ consultantId: selected.id, reason: reasonInput.trim() })
      setActionSuccess(`${selected.display_name} terminated.`)
      setRefreshKey((k) => k + 1)
      setSelected(null)
      setReasonInput('')
    } catch (err) {
      setActionError(toUserMessage(err, 'Terminate failed.'))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReactivate(): Promise<void> {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await reactivateConsultant({ consultantId: selected.id })
      setActionSuccess(`${selected.display_name} reactivated.`)
      setRefreshKey((k) => k + 1)
      setSelected(null)
    } catch (err) {
      setActionError(toUserMessage(err, 'Reactivate failed.'))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleTierAssign(): Promise<void> {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      await assignConsultantCommissionRate({ consultantId: selected.id, commissionTier: tierInput })
      setActionSuccess(`${selected.display_name} moved to ${tierInput} tier.`)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setActionError(toUserMessage(err, 'Tier assignment failed.'))
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <>
      <section className="hero">
        <SectionIntro
          eyebrow="Consultants"
          title="Manage consultant accounts."
          description="Filter by status, search by name or email, and take action on individual accounts."
          titleAs="h1"
        />
      </section>

      {actionSuccess ? <AlertBanner kind="success">{actionSuccess}</AlertBanner> : null}
      {error ? (
        <AlertBanner
          kind="error"
          actionLabel={retryable ? 'Try again' : undefined}
          onAction={retryable ? () => setRefreshKey((k) => k + 1) : undefined}
        >
          {error}
        </AlertBanner>
      ) : null}

      {/* ── Filters ── */}
      <div className="admin-filter-row">
        <input
          type="text"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          className="admin-search-input"
        />
        <div className="admin-filter-tabs" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`admin-filter-tab${statusFilter === value ? ' admin-filter-tab--active' : ''}`}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="admin-total-count">{total} total</span>
      </div>

      {/* ── Consultant table ── */}
      {loading ? (
        <div className="admin-table-skeleton" role="status" aria-label="Loading consultants">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="admin-skeleton-row">
              <div className="skeleton-line wide" />
              <div className="skeleton-line medium" />
            </div>
          ))}
        </div>
      ) : consultants.length === 0 ? (
        <EmptyState
          title="No consultants found"
          description="Try adjusting your search or status filter."
        />
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Gross sales</th>
                <th>Commission</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {consultants.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.display_name}</strong></td>
                  <td>{c.email}</td>
                  <td>{c.commission_tier}</td>
                  <td>
                    <Badge variant={statusBadgeVariant(c.status)}>
                      {c.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td>{formatCurrency(c.lifetime_gross_sales_cents ?? 0)}</td>
                  <td>{formatCurrency(c.lifetime_commissions_cents ?? 0)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSelected(c)
                        setTierInput(c.commission_tier as CommissionTier)
                        setActionError(null)
                        setActionSuccess(null)
                        setReasonInput('')
                      }}
                    >
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Selected consultant detail panel ── */}
      {selected ? (
        <section className="admin-detail-panel">
          <div className="admin-detail-panel__head">
            <Heading as="h3" display={false}>{selected.display_name}</Heading>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>

          <dl className="admin-detail-dl">
            <dt>Email</dt><dd>{selected.email}</dd>
            <dt>Status</dt><dd>{selected.status}</dd>
            <dt>Tier</dt><dd>{selected.commission_tier}</dd>
          </dl>

          {actionError ? <InlineMessage kind="error">{actionError}</InlineMessage> : null}

          {/* Tier assignment */}
          <div className="admin-action-row">
            <label htmlFor="tier-select">Commission tier</label>
            <select
              id="tier-select"
              value={tierInput}
              onChange={(e) => setTierInput(e.target.value as CommissionTier)}
              disabled={actionLoading}
            >
              {TIER_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleTierAssign()}
              disabled={actionLoading}
            >
              Assign Tier
            </Button>
          </div>

          {/* Status actions */}
          <div className="admin-action-row">
            {selected.status === 'pending_approval' ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleApprove()}
                loading={actionLoading}
              >
                Approve
              </Button>
            ) : null}
            {selected.status === 'suspended' ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleReactivate()}
                loading={actionLoading}
              >
                Reactivate
              </Button>
            ) : null}
          </div>

          {/* Destructive actions — require reason */}
          {(selected.status === 'active' || selected.status === 'pending_approval') ? (
            <div className="admin-destructive-row">
              <label htmlFor="reason-input">Reason (required for suspend / terminate)</label>
              <input
                id="reason-input"
                type="text"
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="State reason for action…"
                disabled={actionLoading}
              />
              <div className="admin-action-buttons">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void handleSuspend()}
                  disabled={actionLoading || !reasonInput.trim()}
                >
                  Suspend
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void handleTerminate()}
                  disabled={actionLoading || !reasonInput.trim()}
                >
                  Terminate
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  )
}
