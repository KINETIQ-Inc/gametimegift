/**
 * PayoutsPage — "/payouts"
 *
 * Approve earned commission entries for payout.
 * Filter by consultant ID or earned-before date.
 */

import { type ChangeEvent, useEffect, useState } from 'react'
import {
  approvePayouts,
  getConsultantPendingPayouts,
  isTransientError,
  toUserMessage,
  type ApprovePayoutsResult,
  type ConsultantPendingPayoutsResult,
} from '@gtg/api'
import { AlertBanner, Button, EmptyState, Heading, SectionIntro } from '@gtg/ui'

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

export function PayoutsPage() {
  const [consultantIdInput, setConsultantIdInput] = useState('')
  const [earnedBeforeInput, setEarnedBeforeInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const [pendingResult, setPendingResult] = useState<ConsultantPendingPayoutsResult | null>(null)
  const [approveResult, setApproveResult] = useState<ApprovePayoutsResult | null>(null)
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  const trimmedId = consultantIdInput.trim() || undefined

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      setRetryable(false)
      try {
        const result = await getConsultantPendingPayouts({ consultantId: trimmedId })
        if (cancelled) return
        setPendingResult(result)
      } catch (err) {
        if (cancelled) return
        setError(toUserMessage(err, 'Failed to load pending payouts.'))
        if (isTransientError(err)) setRetryable(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [trimmedId, refreshKey])

  async function handleApprove(): Promise<void> {
    setApproving(true)
    setApproveError(null)
    setApproveResult(null)
    try {
      const result = await approvePayouts({
        consultantId: trimmedId,
        earnedBefore: earnedBeforeInput.trim() || undefined,
      })
      setApproveResult(result)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setApproveError(toUserMessage(err, 'Approval failed.'))
    } finally {
      setApproving(false)
    }
  }

  const pendingCents = pendingResult?.pending_payout_cents ?? 0
  const pendingCount = pendingResult?.entries_count ?? 0

  return (
    <>
      <section className="hero">
        <SectionIntro
          eyebrow="Payouts"
          title="Approve commission payouts."
          description="Review pending commission entries and approve them for disbursement. Filter by consultant or earned date."
          titleAs="h1"
        />
      </section>

      {approveResult ? (
        <AlertBanner kind="success">
          Approved {approveResult.approved_count} entries totaling {formatCurrency(approveResult.total_approved_cents)}.
        </AlertBanner>
      ) : null}
      {approveError ? <AlertBanner kind="error">{approveError}</AlertBanner> : null}
      {error ? (
        <AlertBanner
          kind="error"
          actionLabel={retryable ? 'Try again' : undefined}
          onAction={retryable ? () => setRefreshKey((k) => k + 1) : undefined}
        >
          {error}
        </AlertBanner>
      ) : null}

      {/* ── Filter form ── */}
      <section className="admin-panel">
        <Heading as="h3" display={false}>Filter &amp; Approve</Heading>

        <div className="admin-filter-row">
          <label htmlFor="payout-consultant-id">Consultant ID (optional)</label>
          <input
            id="payout-consultant-id"
            type="text"
            value={consultantIdInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setConsultantIdInput(e.target.value)}
            placeholder="UUID — leave blank for all consultants"
            disabled={approving}
          />

          <label htmlFor="payout-earned-before">Earned before (optional)</label>
          <input
            id="payout-earned-before"
            type="date"
            value={earnedBeforeInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEarnedBeforeInput(e.target.value)}
            disabled={approving}
          />
        </div>
      </section>

      {/* ── Pending summary ── */}
      {!loading && pendingResult ? (
        <section className="admin-panel">
          <div className="admin-payout-summary">
            <div className="admin-payout-stat">
              <span>Pending entries</span>
              <strong>{pendingCount}</strong>
            </div>
            <div className="admin-payout-stat">
              <span>Total pending</span>
              <strong>{formatCurrency(pendingCents)}</strong>
            </div>
            <Button
              variant="primary"
              loading={approving}
              disabled={pendingCount === 0}
              onClick={() => void handleApprove()}
            >
              Approve Payouts
            </Button>
          </div>

          {pendingResult.entries.length > 0 ? (
            <div className="record-list">
              {pendingResult.entries.map((entry) => (
                <article key={entry.entry_id} className="record-row">
                  <div>
                    <strong>{entry.product_name}</strong>
                    <p>{entry.order_number} · {entry.sku} · {entry.commission_tier}</p>
                  </div>
                  <div className="record-values">
                    <span>{formatCurrency(entry.retail_price_cents)}</span>
                    <span>{formatCurrency(entry.commission_cents)} pending</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No pending payouts"
              description="All earned commissions have been approved or there are no entries matching this filter."
            />
          )}
        </section>
      ) : loading ? (
        <div className="admin-table-skeleton" role="status" aria-label="Loading payouts">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="admin-skeleton-row">
              <div className="skeleton-line wide" />
              <div className="skeleton-line medium" />
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
