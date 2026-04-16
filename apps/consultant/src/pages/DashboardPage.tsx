/**
 * DashboardPage — "/dashboard"
 *
 * Overview metrics for the authenticated consultant:
 *   - Gross sales, net commission, pending payout (current month)
 *   - Recent orders table
 *   - Recent commission entries table
 *   - Quick links to Earnings and Referral Tools
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertBanner, Button, EmptyState, Heading, SectionIntro } from '@gtg/ui'
import {
  getConsultantCommissionEarned,
  getConsultantPendingPayouts,
  getConsultantUnitsSold,
  isTransientError,
  toUserMessage,
  type ConsultantCommissionEarnedResult,
  type ConsultantPendingPayoutsResult,
  type ConsultantUnitsSoldResult,
} from '@gtg/api'
import { buildRevenueOverview } from '../revenue-engine'

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

function formatDate(value: string | null): string {
  if (!value) return 'N/A'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString()
}

function getCurrentMonthWindow(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(start), end: iso(now) }
}

export function DashboardPage() {
  const period = useMemo(() => getCurrentMonthWindow(), [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const [unitsResult, setUnitsResult] = useState<ConsultantUnitsSoldResult | null>(null)
  const [commissionResult, setCommissionResult] = useState<ConsultantCommissionEarnedResult | null>(null)
  const [pendingResult, setPendingResult] = useState<ConsultantPendingPayoutsResult | null>(null)

  const overview = useMemo(
    () => buildRevenueOverview(unitsResult, commissionResult, pendingResult),
    [unitsResult, commissionResult, pendingResult],
  )

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      setRetryable(false)
      try {
        const [units, commissions, pending] = await Promise.all([
          getConsultantUnitsSold({ periodStart: period.start, periodEnd: period.end }),
          getConsultantCommissionEarned({ periodStart: period.start, periodEnd: period.end }),
          getConsultantPendingPayouts(),
        ])
        if (cancelled) return
        setUnitsResult(units)
        setCommissionResult(commissions)
        setPendingResult(pending)
      } catch (err) {
        if (cancelled) return
        setError(toUserMessage(err, 'Failed to load dashboard.'))
        if (isTransientError(err)) setRetryable(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [period.start, period.end, refreshKey])

  return (
    <div className="dashboard-page">
      <SectionIntro
        eyebrow="This Month"
        title={`Welcome back${unitsResult?.display_name ? `, ${unitsResult.display_name}` : ''}.`}
        description="Your sales and commission performance for the current month."
      />

      {error ? (
        <AlertBanner
          kind="error"
          actionLabel={retryable ? 'Try again' : undefined}
          onAction={retryable ? () => setRefreshKey((k) => k + 1) : undefined}
        >
          {error}
        </AlertBanner>
      ) : null}

      {loading && !unitsResult ? (
        <div className="dashboard-skeleton-grid" role="status" aria-label="Loading dashboard">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="dashboard-skeleton-card">
              <div className="skeleton-line medium" />
              <div className="skeleton-line wide" />
            </div>
          ))}
        </div>
      ) : (
        <div className="stats" aria-label="Revenue overview">
          <article className="hero-metric-card">
            <span>Gross sales this month</span>
            <strong>{formatCurrency(overview.grossSalesCents)}</strong>
            <p>{overview.conversionLabel}</p>
          </article>
          <article className="hero-metric-card">
            <span>Net commission earned</span>
            <strong>{formatCurrency(overview.earnedCents)}</strong>
            <p>After voids and reversals</p>
          </article>
          <article className="hero-metric-card">
            <span>Pending payout</span>
            <strong>{formatCurrency(overview.pendingPayoutCents)}</strong>
            <p>Moving toward disbursement</p>
          </article>
        </div>
      )}

      <div className="dashboard-quick-links">
        <Link to="/earnings" className="dashboard-quick-link">
          <Heading as="h4">View Full Earnings →</Heading>
          <p>Detailed commission history, date filters, and payout tracker.</p>
        </Link>
        <Link to="/referrals" className="dashboard-quick-link">
          <Heading as="h4">Referral Tools →</Heading>
          <p>Get your link, copy it, share it across channels.</p>
        </Link>
      </div>

      <div className="detail-grid">
        <section className="detail-card">
          <div className="detail-card-head">
            <Heading as="h3" display={false}>Recent Orders</Heading>
            <p>Orders attributed to your referral this month.</p>
          </div>
          {unitsResult && unitsResult.recent_orders.length > 0 ? (
            <div className="record-list">
              {unitsResult.recent_orders.slice(0, 5).map((order) => (
                <article key={order.order_id} className="record-row">
                  <div>
                    <strong>{order.product_name ?? 'Unknown product'}</strong>
                    <p>{order.order_number} · {order.sku ?? '—'} · {order.status}</p>
                  </div>
                  <div className="record-values">
                    <span>{formatCurrency(order.retail_price_cents ?? 0)}</span>
                    <span>{formatCurrency(order.commission_cents ?? 0)} commission</span>
                    <span>{formatDate(order.paid_at)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No orders yet this month"
              description="Share your referral link to start attributing sales."
            />
          )}
          {(unitsResult?.recent_orders.length ?? 0) > 5 ? (
            <Link to="/earnings" className="detail-card-more">View all orders →</Link>
          ) : null}
        </section>

        <section className="detail-card">
          <div className="detail-card-head">
            <Heading as="h3" display={false}>Recent Commission Entries</Heading>
            <p>Commission recorded for each closed order.</p>
          </div>
          {commissionResult && commissionResult.recent_entries.length > 0 ? (
            <div className="record-list">
              {commissionResult.recent_entries.slice(0, 5).map((entry) => (
                <article key={entry.entry_id} className="record-row">
                  <div>
                    <strong>{entry.product_name}</strong>
                    <p>{entry.order_number} · {entry.sku} · {entry.status}</p>
                  </div>
                  <div className="record-values">
                    <span>{(entry.commission_rate * 100).toFixed(2)}%</span>
                    <span>{formatCurrency(entry.commission_cents)}</span>
                    <span>{formatDate(entry.created_at)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No commission entries this month"
              description="Commissions appear here once orders are processed."
            />
          )}
          {(commissionResult?.recent_entries.length ?? 0) > 5 ? (
            <Link to="/earnings" className="detail-card-more">View all commissions →</Link>
          ) : null}
        </section>
      </div>

      <div className="dashboard-cta-row">
        <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
    </div>
  )
}
