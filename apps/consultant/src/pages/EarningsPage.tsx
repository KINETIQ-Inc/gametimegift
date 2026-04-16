/**
 * EarningsPage — "/earnings"
 *
 * Full earnings history with date filter, status breakdown,
 * commission entries table, pending payout panel, and earnings calculator.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertBanner, EmptyState, Heading, SectionIntro } from '@gtg/ui'
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
import {
  buildRevenueOverview,
  deriveSuggestedCommissionRate,
  estimateCommissionScenario,
} from '../revenue-engine'

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

export function EarningsPage() {
  const [period, setPeriod] = useState(getCurrentMonthWindow)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const [unitsResult, setUnitsResult] = useState<ConsultantUnitsSoldResult | null>(null)
  const [commissionResult, setCommissionResult] = useState<ConsultantCommissionEarnedResult | null>(null)
  const [pendingResult, setPendingResult] = useState<ConsultantPendingPayoutsResult | null>(null)

  const [calculatorRetailInput, setCalculatorRetailInput] = useState('149')
  const [calculatorRateInput, setCalculatorRateInput] = useState('10')
  const [calculatorQuantityInput, setCalculatorQuantityInput] = useState('8')

  const overview = useMemo(
    () => buildRevenueOverview(unitsResult, commissionResult, pendingResult),
    [unitsResult, commissionResult, pendingResult],
  )

  const calculatorRetailCents = Math.max(0, Math.round((Number.parseFloat(calculatorRetailInput) || 0) * 100))
  const calculatorRate = Math.max(0, (Number.parseFloat(calculatorRateInput) || 0) / 100)
  const calculatorQuantity = Math.max(1, Number.parseInt(calculatorQuantityInput || '1', 10) || 1)

  const calculatorScenario = useMemo(
    () => estimateCommissionScenario(calculatorRetailCents, calculatorRate, calculatorQuantity),
    [calculatorRetailCents, calculatorRate, calculatorQuantity],
  )

  useEffect(() => {
    const suggested = deriveSuggestedCommissionRate(commissionResult)
    setCalculatorRateInput((suggested * 100).toFixed(2).replace(/\.00$/, ''))
  }, [commissionResult])

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
        setError(toUserMessage(err, 'Failed to load earnings.'))
        if (isTransientError(err)) setRetryable(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [period.start, period.end, refreshKey])

  const hasNoData = !loading && unitsResult?.period_summary.units_sold === 0

  return (
    <div className="earnings-page">
      <SectionIntro
        eyebrow="Earnings"
        title="Sales, commissions, and payouts."
        description="Filter by date range to see your earnings for any period."
      />

      {/* ── Date filter ── */}
      <form className="period-form" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="period-start">Period start</label>
        <input
          id="period-start"
          type="date"
          value={period.start}
          onChange={(e) => setPeriod((prev) => ({ ...prev, start: e.target.value }))}
          required
        />
        <label htmlFor="period-end">Period end</label>
        <input
          id="period-end"
          type="date"
          value={period.end}
          onChange={(e) => setPeriod((prev) => ({ ...prev, end: e.target.value }))}
          required
        />
        <div className="status-pill" aria-live="polite">
          {loading ? 'Refreshing…' : 'Dashboard synced'}
        </div>
      </form>

      {error ? (
        <AlertBanner
          kind="error"
          actionLabel={retryable ? 'Try again' : undefined}
          onAction={retryable ? () => setRefreshKey((k) => k + 1) : undefined}
        >
          {error}
        </AlertBanner>
      ) : null}

      {/* ── Summary stats ── */}
      {loading && !unitsResult ? (
        <div className="dashboard-skeleton-grid" role="status" aria-label="Loading earnings">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="dashboard-skeleton-card">
              <div className="skeleton-line medium" />
              <div className="skeleton-line wide" />
            </div>
          ))}
        </div>
      ) : hasNoData ? (
        <EmptyState
          className="dashboard-empty-state"
          title="No sales in this period"
          description="Share your referral link to start attributing orders. Your earnings will appear here once sales are recorded."
          hint="Try a wider date range."
        />
      ) : (
        <div className="stats">
          <article>
            <span>Units sold</span>
            <strong>{unitsResult?.period_summary.units_sold ?? 0}</strong>
            <p>{unitsResult?.period_summary.orders_count ?? 0} orders in period</p>
          </article>
          <article>
            <span>Gross sales</span>
            <strong>{formatCurrency(unitsResult?.period_summary.gross_sales_cents ?? 0)}</strong>
            <p>Total retail value of attributed orders</p>
          </article>
          <article>
            <span>Period commission</span>
            <strong>{formatCurrency(commissionResult?.period_summary.net_cents ?? 0)}</strong>
            <p>{commissionResult?.period_summary.entries_count ?? 0} commission entries</p>
          </article>
          <article>
            <span>Lifetime commission</span>
            <strong>{formatCurrency(commissionResult?.lifetime.commissions_cents ?? 0)}</strong>
            <p>Accumulated earnings to date</p>
          </article>
          <article>
            <span>Pending payout</span>
            <strong>{formatCurrency(pendingResult?.pending_payout_cents ?? 0)}</strong>
            <p>{pendingResult?.entries_count ?? 0} entries awaiting payout</p>
          </article>
          <article>
            <span>Paid in period</span>
            <strong>{formatCurrency(commissionResult?.period_summary.paid_cents ?? 0)}</strong>
            <p>Already cleared this period</p>
          </article>
        </div>
      )}

      <div className="detail-grid">
        {/* ── Commission entries ── */}
        <section className="detail-card">
          <div className="detail-card-head">
            <Heading as="h3" display={false}>Commission Entries</Heading>
            <p>Rate, tier, and payout amount for each order.</p>
          </div>
          {commissionResult && commissionResult.recent_entries.length > 0 ? (
            <div className="record-list">
              {commissionResult.recent_entries.map((entry) => (
                <article key={entry.entry_id} className="record-row">
                  <div>
                    <strong>{entry.product_name}</strong>
                    <p>{entry.order_number} · {entry.sku} · {entry.status}</p>
                  </div>
                  <div className="record-values">
                    <span>{(entry.commission_rate * 100).toFixed(2)}% {entry.commission_tier}</span>
                    <span>{formatCurrency(entry.commission_cents)}</span>
                    <span>{formatDate(entry.created_at)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !loading ? <p className="muted">No commission entries in this period.</p> : null
          )}
        </section>

        {/* ── Pending payout ── */}
        <section className="detail-card">
          <div className="detail-card-head">
            <Heading as="h3" display={false}>Pending Payout</Heading>
            <p>Approved commissions moving toward disbursement.</p>
          </div>
          {pendingResult && pendingResult.entries.length > 0 ? (
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
                    <span>{formatDate(entry.earned_at)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !loading ? <p className="muted">No pending payout entries right now.</p> : null
          )}
        </section>
      </div>

      {/* ── Earnings calculator ── */}
      <section className="panel calculator-panel">
        <SectionIntro
          className="panel-head"
          eyebrow="Earnings Estimator"
          title="See what you earn before you start sharing."
          description="Adjust retail price, commission rate, and projected units to model a selling push."
        />

        <div className="calculator-grid">
          <label>
            Retail price
            <input
              type="number"
              min="0"
              step="0.01"
              value={calculatorRetailInput}
              onChange={(e) => setCalculatorRetailInput(e.target.value)}
            />
          </label>
          <label>
            Commission rate %
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={calculatorRateInput}
              onChange={(e) => setCalculatorRateInput(e.target.value)}
            />
          </label>
          <label>
            Projected units
            <input
              type="number"
              min="1"
              step="1"
              value={calculatorQuantityInput}
              onChange={(e) => setCalculatorQuantityInput(e.target.value)}
            />
          </label>
        </div>

        <div className="stats projection-stats">
          <article>
            <span>Per-unit commission</span>
            <strong>{formatCurrency(calculatorScenario.perUnitCommissionCents)}</strong>
            <p>{overview.conversionLabel}</p>
          </article>
          <article>
            <span>Projected commission</span>
            <strong>{formatCurrency(calculatorScenario.projectedCommissionCents)}</strong>
            <p>If all projected units close</p>
          </article>
          <article>
            <span>Effective take rate</span>
            <strong>{(calculatorRate * 100).toFixed(2)}%</strong>
            <p>Suggested from recent live entries</p>
          </article>
        </div>
      </section>
    </div>
  )
}
