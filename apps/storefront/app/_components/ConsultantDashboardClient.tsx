'use client'

import { useEffect, useMemo, useState } from 'react'
import { getConsultantDashboard, toUserMessage, type GetConsultantDashboardResult } from '@gtg/api'
import { AppStatePanel, type AppPageState } from '../_lib/route-ui'

function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100)
}

interface ConsultantDashboardClientProps {
  consultantId?: string
  forcedState?: AppPageState | null
}

export function ConsultantDashboardClient(props: ConsultantDashboardClientProps) {
  const { consultantId, forcedState } = props
  const [loading, setLoading] = useState(Boolean(consultantId))
  const [error, setError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<GetConsultantDashboardResult | null>(null)

  useEffect(() => {
    if (!consultantId) {
      setLoading(false)
      return
    }

    let active = true

    async function loadDashboard(): Promise<void> {
      setLoading(true)
      setError(null)

      try {
        const result = await getConsultantDashboard({ consultantId })
        if (!active) return
        setDashboard(result)
      } catch (loadError) {
        if (!active) return
        setError(toUserMessage(loadError, 'Consultant dashboard could not be loaded.'))
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadDashboard()

    return () => {
      active = false
    }
  }, [consultantId])

  const summary = useMemo(() => {
    if (!dashboard) return null

    const paidCents = dashboard.commissionSummary.byStatus.paid.commissionCents
    const pendingCents =
      dashboard.commissionSummary.byStatus.earned.commissionCents +
      dashboard.commissionSummary.byStatus.held.commissionCents +
      dashboard.commissionSummary.byStatus.approved.commissionCents

    return {
      totalEarnings: formatUsd(dashboard.commissionSummary.totalCommissionCents),
      unitsSold: dashboard.orderSummary.totalOrders,
      pending: formatUsd(pendingCents),
      paid: formatUsd(paidCents),
    }
  }, [dashboard])

  if (!consultantId) {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="empty"
          title="Empty state"
          message="Add ?consultantId=UUID to this route to load a real consultant dashboard."
        />
      </div>
    )
  }

  if (forcedState === 'loading') {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="loading"
          title="Loading state"
          message="Loading consultant dashboard…"
        />
      </div>
    )
  }

  if (forcedState === 'error') {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="error"
          title="Error state"
          message="The consultant dashboard could not be loaded for this route."
        />
      </div>
    )
  }

  if (forcedState === 'empty') {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="empty"
          title="Empty state"
          message="This consultant does not have dashboard activity yet."
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="loading"
          title="Loading state"
          message="Loading consultant dashboard…"
        />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel kind="error" title="Error state" message={error} />
      </div>
    )
  }

  if (!summary) {
    return (
      <div style={{ marginTop: 24 }}>
        <AppStatePanel
          kind="empty"
          title="Empty state"
          message="No consultant dashboard data is available for this account yet."
        />
      </div>
    )
  }

  return (
    <section style={{ marginTop: 24 }}>
      <AppStatePanel
        kind="success"
        title="Success state"
        message="Consultant dashboard data loaded successfully."
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
      <article
        style={{
          padding: 18,
          borderRadius: 18,
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <p style={{ margin: 0, opacity: 0.72, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Total Earnings
        </p>
        <strong style={{ display: 'block', marginTop: 10, fontSize: 28 }}>{summary.totalEarnings}</strong>
      </article>

      <article
        style={{
          padding: 18,
          borderRadius: 18,
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <p style={{ margin: 0, opacity: 0.72, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Units Sold
        </p>
        <strong style={{ display: 'block', marginTop: 10, fontSize: 28 }}>{summary.unitsSold}</strong>
      </article>

      <article
        style={{
          padding: 18,
          borderRadius: 18,
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <p style={{ margin: 0, opacity: 0.72, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Pending vs Paid
        </p>
        <strong style={{ display: 'block', marginTop: 10, fontSize: 20 }}>
          {summary.pending} pending
        </strong>
        <span style={{ display: 'block', marginTop: 6, opacity: 0.86 }}>
          {summary.paid} paid
        </span>
      </article>
      </div>
    </section>
  )
}
