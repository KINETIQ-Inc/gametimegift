// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ProductListItem } from '@gtg/api'
import {
  filterProducts,
  findProductByRoute,
  getProductRouteHref,
  parseProductRoute,
} from '../src/product-routing'

const floridaFootball: ProductListItem = {
  id: 'product-1',
  sku: 'FLA-FTBL',
  name: 'University of Florida Collector Football',
  description: 'Display-ready gift for Florida fans.',
  school: 'University of Florida',
  license_body: 'CLC',
  retail_price_cents: 12900,
  available_count: 7,
  in_stock: true,
  created_at: '2026-03-31T00:00:00.000Z',
  updated_at: '2026-03-31T00:00:00.000Z',
}

const armyGift: ProductListItem = {
  ...floridaFootball,
  id: 'product-2',
  sku: 'ARMY-HKY',
  name: 'United States Army Collector Hockey Piece',
  license_body: 'ARMY',
}

describe('product routing helpers', () => {
  it('builds and parses a stable product hash route from sku and slug', () => {
    const href = getProductRouteHref(floridaFootball)

    expect(href).toBe('#product/FLA-FTBL/florida-collector-football')
    expect(parseProductRoute(href)).toEqual({ kind: 'product', sku: 'FLA-FTBL' })
  })

  it('finds the correct product from a parsed route', () => {
    const route = parseProductRoute('#product/ARMY-HKY/united-states-army-collector-hockey-piece')

    expect(findProductByRoute([floridaFootball, armyGift], route)).toEqual(armyGift)
  })

  it('filters products by license and sport in the catalog layer', () => {
    expect(filterProducts([floridaFootball, armyGift], 'CLC', 'FOOTBALL')).toEqual([floridaFootball])
    expect(filterProducts([floridaFootball, armyGift], 'ARMY', 'HOCKEY')).toEqual([armyGift])
  })
})
