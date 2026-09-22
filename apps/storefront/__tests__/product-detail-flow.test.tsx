// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initEnv } from '@gtg/config'
import { resetEnvForTesting } from '@gtg/config/testing'
import App from '../src/App'
import { StorefrontSessionProvider } from '../src/contexts/StorefrontSessionContext'

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
    // StorefrontContext actually calls listProductsWithFallback(), which
    // internally calls the real (unmocked) listProducts() — mocking the
    // package-level export doesn't rewire that internal call. Mock this one
    // directly too, or the app never sees our fixture data.
    listProductsWithFallback: mockListProducts,
    verifyHologramSerial: mockVerifyHologramSerial,
    resolveConsultantCode: mockResolveConsultantCode,
    createOrder: mockCreateOrder,
    // StorefrontSessionProvider (wraps the whole app) bootstraps a session on
    // mount, which needs a real configureSupabase() call production only
    // makes in main.tsx. Mocked here as an anonymous-guest session, same
    // reason the calls above are mocked.
    getAuthSession: vi.fn().mockResolvedValue(null),
    ensureAnonymousSession: vi.fn().mockResolvedValue({
      user: { id: 'anon-1', is_anonymous: true, app_metadata: {} },
    }),
    subscribeToAuthChanges: vi.fn(() => () => {}),
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

// Production renders <App /> inside <StorefrontSessionProvider><BrowserRouter>
// (see BootstrapScreens.tsx) — App itself provides neither, so tests must.
// BrowserRouter specifically (not MemoryRouter) because some code — the
// gift-flow's cart persistence aside, notably CheckoutPage and
// captureReferralAttribution() — reads window.location.search directly
// rather than through a router hook. MemoryRouter never touches
// window.location, so navigate() calls would silently desync from what that
// code actually reads; BrowserRouter keeps both in sync, matching production.
function renderAtRoute(route: string) {
  window.history.pushState({}, '', route)
  return render(
    <StorefrontSessionProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StorefrontSessionProvider>,
  )
}

describe('product detail conversion flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // App → StorefrontProvider calls getEnv() on mount; nothing initializes
    // the env singleton by default in tests (vitest.setup.ts intentionally
    // doesn't, since production code calls initEnv(import.meta.env) once in
    // main.tsx). See packages/config/src/testing.ts for this pattern.
    resetEnvForTesting()
    initEnv({
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_xxx',
      VITE_APP_ENV: 'development',
      VITE_LICENSE_CLC_ACTIVE: 'true',
      VITE_LICENSE_ARMY_ACTIVE: 'true',
      VITE_ROYALTY_RATE_CLC: '0.145',
      VITE_HOLOGRAM_VERIFY_BASE_URL: 'http://localhost:9000/verify',
      VITE_FRAUD_AUTHORITY_ROLES: 'super_admin,admin',
    })
    installMatchMedia(false)
    Element.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
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

  it('loads the product route, adds to cart, and supports gift intent actions', async () => {
    renderAtRoute('/product/FLA-FTBL/florida-collector-football')

    expect(
      await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 }),
    ).toBeInTheDocument()
    expect(document.querySelector('.product-detail-art')?.getAttribute('src')).toContain(
      '/assets/products/florida.png',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add to Cart' }))
    expect(await screen.findByText('Florida Collector Football added to cart.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View Cart' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add Gift Details' }))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'Dad' } })
    fireEvent.change(screen.getByLabelText('Occasion'), { target: { value: "Father's Day" } })
    fireEvent.change(screen.getByLabelText('Gift note'), { target: { value: 'His office shelf needs this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Gift Intent' }))

    expect(await screen.findByText('Florida Collector Football saved to the gift flow.')).toBeInTheDocument()

    const storedCart = JSON.parse(window.localStorage.getItem('gtg-storefront-cart-v1') ?? '[]')
    const giftEntry = storedCart.find((entry: { intent: string }) => entry.intent === 'gift')
    expect(giftEntry?.giftDetails).toEqual({
      recipient: 'Dad',
      occasion: "Father's Day",
      note: 'His office shelf needs this.',
    })
  })

  it('opens the bundle panel and navigates to checkout with the selected bundle', async () => {
    renderAtRoute('/product/FLA-FTBL/florida-collector-football')

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    // First click reveals the purchase-options bundle panel (Buy Now is a
    // two-step affordance: choose a bundle, then confirm). The scroll is
    // deferred via requestAnimationFrame, so it isn't synchronous.
    fireEvent.click(screen.getByRole('button', { name: 'Buy Now' }))
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByRole('radio', { name: /Vase \+ Flowers/i }))
    fireEvent.click(screen.getByRole('radio', { name: /Roses \+ Carnations/i }))

    // Second click (now labeled "Continue to Checkout") actually navigates.
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Checkout' }))

    // Confirms real navigation to /checkout occurred, window.location synced
    // correctly (BrowserRouter, not MemoryRouter — see renderAtRoute), and
    // the checkout form actually rendered rather than a false-positive match
    // on the always-present "Secure Checkout" step label.
    expect(await screen.findByLabelText('Full name')).toBeInTheDocument()
    expect(screen.queryByText('Product not found')).not.toBeInTheDocument()
  })

  it('verifies hologram authenticity from the dedicated authenticity page', async () => {
    renderAtRoute('/authenticity')

    fireEvent.change(screen.getByLabelText('Hologram code'), {
      target: { value: 'GTG-HOLO-0001' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify Authenticity' }))

    await waitFor(() => {
      expect(screen.getByText(/Result:/)).toBeInTheDocument()
    })

    expect(mockVerifyHologramSerial).toHaveBeenCalledWith('GTG-HOLO-0001')
  })

  it('persists referral attribution and pre-fills the consultant code at checkout', async () => {
    renderAtRoute('/checkout?sku=FLA-FTBL&ref=GTG-SELLER1')

    expect(await screen.findByLabelText('Full name')).toBeInTheDocument()
    expect(window.localStorage.getItem('gtg-referral-attribution-v1')).toContain('GTG-SELLER1')

    // A resolved referral code auto-opens the code disclosure and pre-fills
    // it (see CheckoutPage's effect) — no manual toggle click needed.
    expect(await screen.findByLabelText('Consultant code')).toHaveValue('GTG-SELLER1')
  })

  it('shows an out-of-stock notice and removes purchase actions when the product is unavailable', async () => {
    mockListProducts.mockResolvedValue({
      products: [{ ...products[0], in_stock: false, available_count: 0 }],
      total: 1,
      limit: 120,
      offset: 0,
    })

    renderAtRoute('/product/FLA-FTBL/florida-collector-football')

    await screen.findByRole('heading', { name: 'Florida Collector Football', level: 1 })

    // No purchase buttons — no false affordance.
    expect(screen.queryByRole('button', { name: 'Buy Now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to Cart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Gift Details' })).not.toBeInTheDocument()

    // Honest out-of-stock notice with a way back to the catalog.
    expect(screen.getByText(/out of stock/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Browse available gifts/i })).toBeInTheDocument()
  })

  // The disclosure toggle, inline validation, and createOrder-retry scenarios
  // that used to live here now duplicate apps/storefront/__tests__/checkout-page.test.tsx
  // exactly (same CheckoutPage component, same "Pay Securely" flow) — removed
  // here rather than kept as a second, drifting copy of the same coverage.
})
