// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  buildChannelReferralLinks,
  buildRevenueOverview,
  deriveSuggestedCommissionRate,
  estimateCommissionScenario,
} from '../src/revenue-engine'

describe('revenue engine helpers', () => {
  it('builds channel-specific referral links with marketing params', () => {
    const links = buildChannelReferralLinks('https://gametimegift.com/?ref=coach99')

    expect(links).toHaveLength(3)
    expect(links[0]?.href).toContain('ref=coach99')
    expect(links[0]?.href).toContain('utm_source=text')
  })

  it('derives combined revenue overview from dashboard results', () => {
    const overview = buildRevenueOverview(
      {
        consultant_id: 'consultant-1',
        display_name: 'Jordan Coach',
        period: { start: '2026-03-01', end: '2026-03-31' },
        period_summary: {
          orders_count: 4,
          units_sold: 6,
          gross_sales_cents: 89400,
          commission_cents: 8940,
        },
        lifetime: {
          gross_sales_cents: 120000,
          commissions_cents: 12000,
          pending_payout_cents: 4100,
        },
        recent_orders: [],
      },
      {
        consultant_id: 'consultant-1',
        display_name: 'Jordan Coach',
        period: { start: '2026-03-01', end: '2026-03-31' },
        period_summary: {
          entries_count: 4,
          earned_cents: 8940,
          paid_cents: 4000,
          voided_cents: 0,
          net_cents: 8940,
        },
        lifetime: {
          gross_sales_cents: 120000,
          commissions_cents: 12000,
          pending_payout_cents: 4100,
        },
        recent_entries: [],
      },
      {
        consultant_id: 'consultant-1',
        display_name: 'Jordan Coach',
        pending_payout_cents: 4100,
        entries_count: 2,
        entries: [],
      },
    )

    expect(overview.grossSalesCents).toBe(89400)
    expect(overview.earnedCents).toBe(8940)
    expect(overview.pendingPayoutCents).toBe(4100)
    expect(overview.conversionLabel).toBe('6 units across 4 orders')
  })

  it('estimates per-unit and projected commission using shared math', () => {
    expect(estimateCommissionScenario(14900, 0.1, 8)).toEqual({
      perUnitCommissionCents: 1490,
      projectedCommissionCents: 11920,
    })
  })

  it('uses recent commission rate when available', () => {
    expect(
      deriveSuggestedCommissionRate({
        consultant_id: 'consultant-1',
        display_name: 'Jordan Coach',
        period: { start: '2026-03-01', end: '2026-03-31' },
        period_summary: {
          entries_count: 1,
          earned_cents: 1200,
          paid_cents: 0,
          voided_cents: 0,
          net_cents: 1200,
        },
        lifetime: {
          gross_sales_cents: 12000,
          commissions_cents: 1200,
          pending_payout_cents: 1200,
        },
        recent_entries: [
          {
            entry_id: 'entry-1',
            order_id: 'order-1',
            order_number: 'GTG-1',
            serial_number: 'SER-1',
            sku: 'SKU-1',
            product_name: 'Collector Football',
            retail_price_cents: 14900,
            commission_tier: 'standard',
            commission_rate: 0.12,
            commission_cents: 1788,
            status: 'earned',
            created_at: '2026-03-31T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(0.12)
  })
})
