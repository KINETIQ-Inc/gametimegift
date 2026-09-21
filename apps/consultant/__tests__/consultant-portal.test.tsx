// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'

function renderApp(initialRoute = '/dashboard') {
  // Production renders <App /> inside <BrowserRouter> (see main.tsx) — App
  // itself has no Router of its own, so the test must supply one too.
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <App />
    </MemoryRouter>,
  )
}

const {
  mockGetReferralLink,
  mockGetConsultantUnitsSold,
  mockGetConsultantCommissionEarned,
  mockGetConsultantPendingPayouts,
} = vi.hoisted(() => ({
  mockGetReferralLink: vi.fn(),
  mockGetConsultantUnitsSold: vi.fn(),
  mockGetConsultantCommissionEarned: vi.fn(),
  mockGetConsultantPendingPayouts: vi.fn(),
}))

vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')

  return {
    ...actual,
    getReferralLink: mockGetReferralLink,
    getConsultantUnitsSold: mockGetConsultantUnitsSold,
    getConsultantCommissionEarned: mockGetConsultantCommissionEarned,
    getConsultantPendingPayouts: mockGetConsultantPendingPayouts,
    // AuthProvider (wraps the whole App) calls getAuthSession() on mount,
    // which needs a real configureSupabase() call production only makes in
    // main.tsx. Mocked here for the same reason the dashboard calls above are.
    getAuthSession: vi.fn().mockResolvedValue(
      { role: 'consultant', userId: 'consultant-1', email: 'consultant@test.gtg' },
    ),
    subscribeToAuthChanges: vi.fn(() => () => {}),
  }
})

describe('consultant portal revenue engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })

    mockGetConsultantUnitsSold.mockResolvedValue({
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
      recent_orders: [
        {
          order_id: 'order-1',
          order_number: 'GTG-20260331-000001',
          status: 'paid',
          paid_at: '2026-03-31T00:00:00.000Z',
          product_name: 'University of Florida Collector Football',
          serial_number: 'SER-123',
          sku: 'FLA-FTBL',
          retail_price_cents: 14900,
          commission_cents: 1490,
        },
      ],
    })

    mockGetConsultantCommissionEarned.mockResolvedValue({
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
      recent_entries: [
        {
          entry_id: 'entry-1',
          order_id: 'order-1',
          order_number: 'GTG-20260331-000001',
          serial_number: 'SER-123',
          sku: 'FLA-FTBL',
          product_name: 'University of Florida Collector Football',
          retail_price_cents: 14900,
          commission_tier: 'standard',
          commission_rate: 0.1,
          commission_cents: 1490,
          status: 'earned',
          created_at: '2026-03-31T00:00:00.000Z',
        },
      ],
    })

    mockGetConsultantPendingPayouts.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Coach',
      pending_payout_cents: 4100,
      entries_count: 2,
      entries: [
        {
          entry_id: 'entry-1',
          order_id: 'order-1',
          order_number: 'GTG-20260331-000001',
          serial_number: 'SER-123',
          sku: 'FLA-FTBL',
          product_name: 'University of Florida Collector Football',
          retail_price_cents: 14900,
          commission_tier: 'standard',
          commission_rate: 0.1,
          commission_cents: 1490,
          earned_at: '2026-03-31T00:00:00.000Z',
        },
      ],
    })

    mockGetReferralLink.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Coach',
      referral_code: 'COACH99',
      referral_url: 'https://gametimegift.com/?ref=COACH99',
      share_text: 'Shop my official Game Time Gift collection.',
      lifetime_gross_sales_cents: 120000,
      lifetime_commissions_cents: 12000,
      total_referred_orders: 8,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('loads the dashboard with revenue overview and recent activity', async () => {
    renderApp('/dashboard')

    // "Welcome back, Jordan Coach." is one text node — match the substring.
    expect(await screen.findByText(/Welcome back, Jordan Coach\./)).toBeInTheDocument()
    expect(screen.getByText('Gross sales this month')).toBeInTheDocument()
    expect(screen.getByText('$894.00')).toBeInTheDocument() // gross_sales_cents: 89400
    expect(screen.getAllByText(/GTG-20260331-000001/).length).toBeGreaterThan(0)
  })

  it('generates a consultant referral link on the referral tools page', async () => {
    renderApp('/referrals')

    fireEvent.click(await screen.findByRole('button', { name: 'Get My Link' }))

    expect(await screen.findByText('https://gametimegift.com/?ref=COACH99')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeInTheDocument()
  })

  it('updates the commission calculator with shared projection math', async () => {
    renderApp('/earnings')

    // Wait for the initial load to finish — the calculator's suggested
    // commission rate is derived from fetched data via a useEffect, so
    // interacting before that resolves would race it.
    await screen.findByText('Dashboard synced')

    fireEvent.change(screen.getByLabelText('Retail price'), { target: { value: '199' } })
    fireEvent.change(screen.getByLabelText('Commission rate %'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Projected units'), { target: { value: '5' } })

    expect(screen.getByText('$23.88')).toBeInTheDocument()
    expect(screen.getByText('$119.40')).toBeInTheDocument()
  })

  it('shows a loading skeleton while the dashboard is fetching for the first time', async () => {
    // All three API calls hang indefinitely — simulates in-flight initial load.
    mockGetConsultantUnitsSold.mockReturnValue(new Promise(() => {}))
    mockGetConsultantCommissionEarned.mockReturnValue(new Promise(() => {}))
    mockGetConsultantPendingPayouts.mockReturnValue(new Promise(() => {}))

    renderApp('/dashboard')

    // PortalShell shows its own "Checking session…" state until the mocked
    // getAuthSession() promise resolves — wait past it to the dashboard's
    // own loading skeleton underneath.
    expect(await screen.findByRole('status', { name: 'Loading dashboard' })).toBeInTheDocument()
    // Stats cards must not render during initial load.
    expect(screen.queryByText('Gross sales this month')).not.toBeInTheDocument()
  })

  it('shows the empty state when a consultant has no sales in the period', async () => {
    const zeroPeriod = {
      orders_count: 0,
      units_sold: 0,
      gross_sales_cents: 0,
      commission_cents: 0,
    }

    mockGetConsultantUnitsSold.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Coach',
      period: { start: '2026-03-01', end: '2026-03-31' },
      period_summary: zeroPeriod,
      lifetime: { gross_sales_cents: 0, commissions_cents: 0, pending_payout_cents: 0 },
      recent_orders: [],
    })
    mockGetConsultantCommissionEarned.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Coach',
      period: { start: '2026-03-01', end: '2026-03-31' },
      period_summary: { entries_count: 0, earned_cents: 0, paid_cents: 0, voided_cents: 0, net_cents: 0 },
      lifetime: { gross_sales_cents: 0, commissions_cents: 0, pending_payout_cents: 0 },
      recent_entries: [],
    })
    mockGetConsultantPendingPayouts.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Coach',
      pending_payout_cents: 0,
      entries_count: 0,
      entries: [],
    })

    renderApp('/dashboard')

    // The dashboard shows zero-value stat cards (not hidden) plus two
    // section-level empty states, one per record list.
    expect(await screen.findByText('No orders yet this month')).toBeInTheDocument()
    expect(screen.getByText('No commission entries this month')).toBeInTheDocument()
    expect(screen.getByText('Gross sales this month')).toBeInTheDocument()
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0)
  })
})
