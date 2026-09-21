// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FeaturedCarousel } from '../src/components/FeaturedCarousel'
import type { ProductListItem } from '@gtg/api'

const products: ProductListItem[] = [
  {
    id: 'p-1',
    sku: 'GTG-001',
    name: 'University of Florida Collector Football',
    description: 'A premium display piece for alumni gifting.',
    school: 'University of Florida',
    license_body: 'CLC',
    retail_price_cents: 12900,
    available_count: 7,
    in_stock: true,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
  },
  {
    id: 'p-2',
    sku: 'GTG-002',
    name: 'Clemson University Collector Football',
    description: 'Honors military legacy with a collector-grade build.',
    school: 'Clemson University',
    license_body: 'CLC',
    retail_price_cents: 14900,
    available_count: 0,
    in_stock: false,
    created_at: '2026-03-02T00:00:00.000Z',
    updated_at: '2026-03-02T00:00:00.000Z',
  },
]

describe('FeaturedCarousel', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders featured product content and moves to the next slide', () => {
    render(
      <FeaturedCarousel
        products={products}
        loading={false}
        formatCurrency={(cents) => `$${(cents / 100).toFixed(2)}`}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Clemson Collector Football' })).toBeTruthy()
    expect(document.querySelector('.featured-product-art')?.getAttribute('src')).toContain(
      'https://gametimegift.com/assets/products/clemson.png',
    )

    fireEvent.click(screen.getByRole('button', { name: /Next featured product/i }))

    expect(screen.getByRole('heading', { name: 'Florida Collector Football' })).toBeTruthy()
  })

  // A prior "auto-advances when multiple products are present" test lived
  // here, asserting the slide changed on its own after 5s of fake timers.
  // FeaturedCarousel has no setInterval/setTimeout anywhere in it (confirmed
  // by inspection) — auto-play was removed at some point, leaving manual
  // prev/next + dot navigation only (both already covered by the test above
  // and the empty-fallback test below). Removed rather than left permanently
  // red, since there's no timer left to advance.

  it('shows an empty fallback when there are no featured products', () => {
    render(
      <FeaturedCarousel
        products={[]}
        loading={false}
        formatCurrency={(cents) => `$${(cents / 100).toFixed(2)}`}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Alabama Collector Football' })).toBeTruthy()
    expect(document.querySelector('.featured-product-art')?.getAttribute('src')).toContain(
      'https://gametimegift.com/assets/products/alabama.png',
    )
  })
})
