// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const {
  fetchOrderByIdMock,
  trackStorefrontEventMock,
} = vi.hoisted(() => ({
  fetchOrderByIdMock: vi.fn(),
  trackStorefrontEventMock: vi.fn(),
}))

vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')
  return {
    ...actual,
    fetchOrderById: fetchOrderByIdMock,
  }
})

vi.mock('../src/analytics', () => ({
  trackStorefrontEvent: trackStorefrontEventMock,
}))

import { OrderConfirmation } from '../src/components/checkout/OrderConfirmation'

const session = {
  orderId: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'GTG-1001',
  sessionId: 'cs_test_123',
  unitId: '22222222-2222-4222-8222-222222222222',
  serialNumber: 'GTG-CLC-2026-0001',
  productId: '33333333-3333-4333-8333-333333333333',
  sku: 'GTG-FTBL-001',
  productName: 'Florida Football Collector Vase',
  retailPriceCents: 12900,
  customerName: 'Jane Smith',
  customerEmail: 'jane@example.com',
  channel: 'storefront_direct' as const,
  initiatedAt: '2026-04-15T21:00:00.000Z',
}

describe('OrderConfirmation sync behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('shows the delayed-success fallback after 15 seconds of pending payment polling', async () => {
    fetchOrderByIdMock.mockResolvedValue({
      order: {
        id: session.orderId,
        order_number: session.orderNumber,
        status: 'pending_payment',
      },
      lines: [],
    })

    render(
      <OrderConfirmation
        orderId={session.orderId}
        session={session}
        onVerify={() => {}}
        onContinue={() => {}}
      />,
    )

    expect(screen.getByText(/Payment confirmed/i)).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    expect(
      screen.getByText(/order confirmation is delayed/i),
    ).toBeTruthy()
  })
})
