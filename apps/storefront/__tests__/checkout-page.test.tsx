// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiRequestError } from '@gtg/api'
import { CheckoutPage } from '../src/pages/CheckoutPage'

const {
  createOrderMock,
  ensureAnonymousSessionMock,
  resolveConsultantCodeMock,
  useStorefrontMock,
  trackStorefrontEventMock,
} = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  ensureAnonymousSessionMock: vi.fn(),
  resolveConsultantCodeMock: vi.fn(),
  useStorefrontMock: vi.fn(),
  trackStorefrontEventMock: vi.fn(),
}))

vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')

  return {
    ...actual,
    createOrder: createOrderMock,
    ensureAnonymousSession: ensureAnonymousSessionMock,
    resolveConsultantCode: resolveConsultantCodeMock,
  }
})

vi.mock('../src/contexts/StorefrontContext', () => ({
  useStorefront: useStorefrontMock,
}))

vi.mock('../src/analytics', () => ({
  trackStorefrontEvent: trackStorefrontEventMock,
}))

vi.mock('../src/referral-attribution', () => ({
  captureReferralAttribution: vi.fn(() => null),
  clearReferralAttribution: vi.fn(),
}))

vi.mock('../src/config/featured-product-art', () => ({
  getFeaturedProductArt: vi.fn(() => null),
}))

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  sku: 'GTG-FTBL-001',
  name: 'Florida Football Collector Vase',
  description: 'Premium collectible.',
  license_body: 'CLC',
  retail_price_cents: 12900,
  available_count: 2,
} as const

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function renderCheckoutPage() {
  window.history.replaceState({}, '', '/checkout?sku=GTG-FTBL-001')
  useStorefrontMock.mockReturnValue({
    products: [product],
    loading: false,
    activeReferralCode: null,
    checkoutEnabled: true,
  })

  return render(<CheckoutPage />)
}

function getSubmitButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole('button', { name: /continue to payment/i })
  return buttons[buttons.length - 1] as HTMLButtonElement
}

async function fillRequiredFields() {
  fireEvent.change(await screen.findByLabelText(/full name/i), {
    target: { value: 'Jane Smith' },
  })
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: 'jane@example.com' },
  })
}

describe('CheckoutPage critical checkout scenarios', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    ensureAnonymousSessionMock.mockResolvedValue(undefined)
    resolveConsultantCodeMock.mockResolvedValue(null)
    trackStorefrontEventMock.mockReturnValue(undefined)
  })

  it('supports anonymous user checkout submission', async () => {
    const pendingCheckout = deferredPromise<{
      order_id: string
      order_number: string
      session_id: string
      session_url: string
      unit_id: string
      serial_number: string
      product_id: string
      sku: string
      product_name: string
      channel: 'storefront_direct'
    }>()
    createOrderMock.mockReturnValue(pendingCheckout.promise)

    renderCheckoutPage()
    await fillRequiredFields()

    fireEvent.click(getSubmitButton())

    await waitFor(() => {
      expect(ensureAnonymousSessionMock).toHaveBeenCalledTimes(1)
      expect(createOrderMock).toHaveBeenCalledTimes(1)
    })

    const [input] = createOrderMock.mock.calls[0] as [{ customerEmail: string; idempotencyKey: string }]
    expect(input.customerEmail).toBe('jane@example.com')
    expect(input.idempotencyKey).toMatch(/.+/)
  })

  it('prevents duplicate checkout on double click', async () => {
    const pendingCheckout = deferredPromise<unknown>()
    createOrderMock.mockReturnValue(pendingCheckout.promise)

    renderCheckoutPage()
    await fillRequiredFields()

    const submitButton = getSubmitButton()
    fireEvent.click(submitButton)
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(createOrderMock).toHaveBeenCalledTimes(1)
    })
  })

  it('retries network failure with the same idempotency key', async () => {
    createOrderMock
      .mockRejectedValueOnce(
        new ApiRequestError('[GTG] createOrder(): Unable to reach the server.', 'FUNCTION_ERROR'),
      )
      .mockImplementationOnce(async () => {
        throw new Error('stop after verifying retry')
      })

    renderCheckoutPage()
    await fillRequiredFields()

    const submitButton = getSubmitButton()
    fireEvent.click(submitButton)

    await screen.findByText(/Unable to reach the server/i)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(createOrderMock).toHaveBeenCalledTimes(2)
    })

    const [firstInput] = createOrderMock.mock.calls[0] as [{ idempotencyKey: string }]
    const [secondInput] = createOrderMock.mock.calls[1] as [{ idempotencyKey: string }]

    expect(firstInput.idempotencyKey).toBe(secondInput.idempotencyKey)
  })

  it('shows the out of stock error state', async () => {
    createOrderMock.mockRejectedValueOnce(
      new ApiRequestError(
        "[GTG] createOrder(): 'Florida Football Collector Vase' is currently out of stock.",
        'FUNCTION_ERROR',
        409,
      ),
    )

    renderCheckoutPage()
    await fillRequiredFields()

    fireEvent.click(getSubmitButton())

    expect(
      await screen.findByText(/currently out of stock/i),
    ).toBeTruthy()
  })
})
