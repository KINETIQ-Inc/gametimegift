// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initEnv } from '@gtg/config'
import { resetEnvForTesting } from '@gtg/config/testing'
import App from '../src/App'
import { StorefrontSessionProvider } from '../src/contexts/StorefrontSessionContext'

const { mockListProducts } = vi.hoisted(() => ({
  mockListProducts: vi.fn(),
}))

vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')

  return {
    ...actual,
    listProducts: mockListProducts,
    listProductsWithFallback: mockListProducts,
    getAuthSession: vi.fn().mockResolvedValue(null),
    ensureAnonymousSession: vi.fn().mockResolvedValue({
      user: { id: 'anon-1', is_anonymous: true, app_metadata: {} },
    }),
    subscribeToAuthChanges: vi.fn(() => () => {}),
  }
})

// Three rows of the same design (S/Navy, M/Navy, M/Red) sharing one
// style_key, plus one unrelated collectible. The catalog must show the
// hoodie once, not three times, while the collectible still shows normally.
const products = [
  {
    id: 'apparel-s-navy',
    sku: 'APP-CLEMSON-HOODIE-S',
    name: 'Clemson University Hoodie',
    description: 'Cozy fleece hoodie.',
    school: 'Clemson University',
    license_body: 'CLC' as const,
    category: 'APPAREL' as const,
    lifecycle_status: 'ACTIVE' as const,
    size: 'S' as const,
    color: 'Navy',
    style_key: 'APP-CLEMSON-HOODIE',
    retail_price_cents: 4500,
    available_count: 5,
    in_stock: true,
    created_at: '2026-03-31T00:00:00.000Z',
    updated_at: '2026-03-31T00:00:00.000Z',
  },
  {
    id: 'apparel-m-navy',
    sku: 'APP-CLEMSON-HOODIE-M',
    name: 'Clemson University Hoodie',
    description: 'Cozy fleece hoodie.',
    school: 'Clemson University',
    license_body: 'CLC' as const,
    category: 'APPAREL' as const,
    lifecycle_status: 'ACTIVE' as const,
    size: 'M' as const,
    color: 'Navy',
    style_key: 'APP-CLEMSON-HOODIE',
    retail_price_cents: 4500,
    available_count: 5,
    in_stock: true,
    created_at: '2026-03-31T00:00:00.000Z',
    updated_at: '2026-03-31T00:00:00.000Z',
  },
  {
    id: 'apparel-m-red',
    sku: 'APP-CLEMSON-HOODIE-M-RED',
    name: 'Clemson University Hoodie',
    description: 'Cozy fleece hoodie.',
    school: 'Clemson University',
    license_body: 'CLC' as const,
    category: 'APPAREL' as const,
    lifecycle_status: 'ACTIVE' as const,
    size: 'M' as const,
    color: 'Red',
    style_key: 'APP-CLEMSON-HOODIE',
    retail_price_cents: 4500,
    available_count: 3,
    in_stock: true,
    created_at: '2026-03-31T00:00:00.000Z',
    updated_at: '2026-03-31T00:00:00.000Z',
  },
  {
    id: 'collectible-florida',
    sku: 'FLA-FTBL',
    name: 'University of Florida Collector Football',
    description: 'Display-ready gift for Florida fans.',
    school: 'University of Florida',
    license_body: 'CLC' as const,
    category: 'COLLECTIBLE' as const,
    lifecycle_status: 'ACTIVE' as const,
    size: null,
    color: null,
    style_key: null,
    retail_price_cents: 12900,
    available_count: 7,
    in_stock: true,
    created_at: '2026-03-31T00:00:00.000Z',
    updated_at: '2026-03-31T00:00:00.000Z',
  },
]

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

describe('shop catalog groups apparel variants by style_key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    window.localStorage.clear()
    mockListProducts.mockResolvedValue({
      products,
      total: products.length,
      limit: 120,
      offset: 0,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows one card per apparel design, not one per size/color row, while collectibles stay one-per-row', async () => {
    renderAtRoute('/shop?category=APPAREL')

    const hoodieCards = await screen.findAllByRole('link', { name: /Clemson Hoodie/i })
    expect(hoodieCards).toHaveLength(1)
  })

  it('does not affect collectibles, which have no style_key to group by', async () => {
    renderAtRoute('/shop')

    const hoodieCards = await screen.findAllByRole('link', { name: /Clemson Hoodie/i })
    expect(hoodieCards).toHaveLength(1)

    const floridaCards = screen.getAllByRole('link', { name: /Florida Collector Football/i })
    expect(floridaCards).toHaveLength(1)
  })
})
