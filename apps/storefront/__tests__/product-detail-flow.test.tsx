// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'

const { mockListProducts, mockVerifyHologramSerial, mockResolveConsultantCode, mockCreateOrder } = vi.hoisted(() => ({
  mockListProducts: vi.fn(),
  mockVerifyHologramSerial: vi.fn(),
  mockResolveConsultantCode: vi.fn(),
  mockCreateOrder: vi.fn(),
}))

vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')

  return {
    ...actual,
    listProducts: mockListProducts,
    verifyHologramSerial: mockVerifyHologramSerial,
    resolveConsultantCode: mockResolveConsultantCode,
    createOrder: mockCreateOrder,
  }
})

const products = [
  {
    id: 'product-1',
    sku: 'FLA-FTBL',
    name: 'University of Florida Collector Football',
    description: 'Display-ready gift for Florida fans.',
    school: 'University of Florida',
    license_body: 'CLC' as const,
    retail_price_cents: 12900,
    available_count: 7,
    in_stock: true,
    created_at: '2026-03-31T00:00:00.000Z',
    updated_at: '2026-03-31T00:00:00.000Z',
  },
]

function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    matches,
    media: '(max-width: 760px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    dispatchEvent: (_event: Event) => true,
    addListener: (_listener: (event: MediaQueryListEvent) => void) => {},
    removeListener: (_listener: (event: MediaQueryListEvent) => void) => {},
  } satisfies MediaQueryList

  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery))
}

describe('product detail conversion flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installMatchMedia(false)
    Element.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.location.hash = '#product/FLA-FTBL/florida-collector-football'
    mockListProducts.mockResolvedValue({
      products,
      total: 1,
      limit: 120,
      offset: 0,
    })
    mockVerifyHologramSerial.mockResolvedValue({
      verified: true,
      serial_number: 'GTG-HOLO-0001',
      sku: 'FLA-FTBL',
      product_name: 'University of Florida Collector Football',
      license_body: 'CLC',
      hologram: null,
      verification_status: 'verified',
      received_at: '2026-03-31T00:00:00.000Z',
      sold_at: null,
    })
    mockResolveConsultantCode.mockResolvedValue({
      consultant_id: 'consultant-1',
      display_name: 'Jordan Seller',
      referral_code: 'GTG-SELLER1',
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('loads the sku route and supports checkout and gift intent actions', async () => {
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 }),
    ).toBeInTheDocument()
    expect(document.querySelector('.product-detail-art')?.getAttribute('src')).toContain(
      'https://gametimegift.com/assets/products/florida.png',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select Gift' }))

    expect(await screen.findByRole('heading', { name: 'Secure Checkout' })).toBeInTheDocument()
    expect(screen.getByLabelText('Full name')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personalize as a Gift' }))

    const recipientField = await screen.findByLabelText('Recipient')
    fireEvent.change(recipientField, { target: { value: 'Dad' } })
    fireEvent.change(screen.getByLabelText('Occasion'), { target: { value: "Father's Day" } })
    fireEvent.change(screen.getByLabelText('Gift note'), { target: { value: 'His office shelf needs this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Gift Intent' }))

    expect(await screen.findByText('Florida Collector Football saved to the gift flow.')).toBeInTheDocument()
    expect(screen.getByText('1 item saved')).toBeInTheDocument()

    const storedCart = JSON.parse(window.localStorage.getItem('gtg-storefront-cart-v1') ?? '[]')
    expect(storedCart[0]?.giftDetails).toEqual({
      recipient: 'Dad',
      occasion: "Father's Day",
      note: 'His office shelf needs this.',
    })
  })

  it('still supports authenticity verification from the same conversion page', async () => {
    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    fireEvent.change(screen.getByLabelText('Hologram code'), {
      target: { value: 'GTG-HOLO-0001' },
    })
    fireEvent.submit(screen.getByRole('button', { name: 'Verify' }).closest('form')!)

    await waitFor(() => {
      expect(screen.getByText(/Result:/)).toBeInTheDocument()
    })

    expect(mockVerifyHologramSerial).toHaveBeenCalledWith('GTG-HOLO-0001')
  })

  it('scrolls to the product detail when the route changes to a sku hash', async () => {
    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    window.location.hash = '#product/FLA-FTBL/florida-collector-football'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    })
  })

  it('persists referral attribution in localStorage and pre-fills checkout', async () => {
    window.history.replaceState({}, '', '/?ref=GTG-SELLER1#product/FLA-FTBL/florida-collector-football')

    render(<App />)

    expect(await screen.findByText(/Shopping with/)).toBeInTheDocument()
    expect(window.localStorage.getItem('gtg-referral-attribution-v1')).toContain('GTG-SELLER1')

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    fireEvent.click(screen.getAllByRole('button', { name: 'Select Gift' })[0]!)

    const consultantField = await screen.findByLabelText(/Consultant code/i)
    expect(consultantField).toHaveValue('GTG-SELLER1')
  })

  it('shows an out-of-stock notice and removes purchase actions when the product is unavailable', async () => {
    mockListProducts.mockResolvedValue({
      products: [{ ...products[0], in_stock: false, available_count: 0 }],
      total: 1,
      limit: 120,
      offset: 0,
    })

    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    // No purchase buttons — no false affordance.
    expect(screen.queryByRole('button', { name: 'Select Gift' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Join Waitlist' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Personalize as a Gift' })).not.toBeInTheDocument()

    // Honest out-of-stock notice with a way back to the catalog.
    expect(screen.getByText(/out of stock/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Browse available gifts/i })).toBeInTheDocument()
  })

  it('hides optional code fields behind a disclosure toggle and reveals them on click', async () => {
    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Select Gift' }))
    await screen.findByRole('heading', { name: 'Secure Checkout' })

    // Fields hidden by default when there is no pre-filled referral code.
    expect(screen.queryByLabelText('Consultant code')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Discount code')).not.toBeInTheDocument()

    // Toggle opens the disclosure.
    fireEvent.click(screen.getByRole('button', { name: /Have a consultant or discount code/i }))
    expect(screen.getByLabelText('Consultant code')).toBeInTheDocument()
    expect(screen.getByLabelText('Discount code')).toBeInTheDocument()

    // Toggle collapses it again.
    fireEvent.click(screen.getByRole('button', { name: /Have a consultant or discount code/i }))
    expect(screen.queryByLabelText('Consultant code')).not.toBeInTheDocument()
  })

  it('shows inline validation errors on submit and clears them when the field is corrected', async () => {
    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Select Gift' }))
    await screen.findByRole('heading', { name: 'Secure Checkout' })

    // Submit with empty name → validation error shown, no retry prompt.
    fireEvent.click(screen.getByRole('button', { name: /Continue to Payment/i }))
    expect(await screen.findByText('Please enter your name.')).toBeInTheDocument()
    expect(screen.queryByText(/Fix the details above/i)).not.toBeInTheDocument()

    // Typing in the name field clears the error.
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Jane Smith' } })
    expect(screen.queryByText('Please enter your name.')).not.toBeInTheDocument()

    // Submit with missing email → different validation error, still no retry prompt.
    fireEvent.click(screen.getByRole('button', { name: /Continue to Payment/i }))
    expect(await screen.findByText('Please enter a valid email address.')).toBeInTheDocument()
    expect(screen.queryByText(/Fix the details above/i)).not.toBeInTheDocument()

    // Typing in the email field clears that error.
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'jane@example.com' } })
    expect(screen.queryByText('Please enter a valid email address.')).not.toBeInTheDocument()
  })

  it('shows an explicit retry prompt when the createOrder API call fails', async () => {
    mockCreateOrder.mockRejectedValue(new Error('Network error'))

    render(<App />)

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Select Gift' }))
    await screen.findByRole('heading', { name: 'Secure Checkout' })

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Jane Smith' } })
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'jane@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue to Payment/i }))

    // API error message + explicit retry prompt both appear.
    expect(await screen.findByText(/Checkout could not be started/i)).toBeInTheDocument()
    expect(screen.getByText(/Fix the details above/i)).toBeInTheDocument()

    // Submit button is re-enabled so the customer can actually retry.
    expect(screen.getByRole('button', { name: /Continue to Payment/i })).not.toBeDisabled()
  })
})
