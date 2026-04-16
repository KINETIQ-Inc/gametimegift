import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../error'
import {
  buildProductBundleScaffold,
  createBundleCatalog,
  estimateBundlePrice,
} from '../bundles'

const product = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  sku: 'GTG-FTBL-001',
  name: 'University of Texas Football Legacy Print',
  description: null,
  school: 'Texas',
  license_body: 'CLC' as const,
  retail_price_cents: 14900,
  available_count: 12,
  in_stock: true,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
}

describe('bundle structures', () => {
  it('builds a scaffolded bundle offer from a product anchor', () => {
    const offer = buildProductBundleScaffold({
      product,
      partnerType: 'floral',
      partnerLabel: 'Floral Partner',
      addOnLabel: 'Seasonal bouquet',
      addOnDescription: 'Fresh stems curated around school colors.',
      addOnEstimatedPriceCents: 5900,
    })

    expect(offer.partner_type).toBe('floral')
    expect(offer.items[0]).toMatchObject({
      kind: 'core_product',
      sku: product.sku,
    })
    expect(offer.pricing.estimated_bundle_price_cents).toBe(20800)
  })

  it('validates duplicate bundle ids in a catalog', () => {
    expect(() =>
      createBundleCatalog({
        version: '2026-04',
        offers: [
          {
            id: 'bundle-1',
            name: 'Bundle 1',
            headline: 'Headline',
            summary: 'Summary',
            tag: 'Tag',
            partner_type: 'corporate',
            ready_state: 'concept',
            occasions: ['Corporate gifting'],
            items: [
              {
                kind: 'core_product',
                source: 'gtg',
                label: 'Anchor',
                description: 'Desc',
                quantity: 1,
              },
            ],
            pricing: {
              mode: 'quote_required',
              anchor_price_cents: null,
              estimated_bundle_price_cents: null,
              premium_copy: 'Quote required',
            },
          },
          {
            id: 'bundle-1',
            name: 'Bundle 2',
            headline: 'Headline',
            summary: 'Summary',
            tag: 'Tag',
            partner_type: 'gift_box',
            ready_state: 'concept',
            occasions: ['Holiday'],
            items: [
              {
                kind: 'core_product',
                source: 'gtg',
                label: 'Anchor',
                description: 'Desc',
                quantity: 1,
              },
            ],
            pricing: {
              mode: 'quote_required',
              anchor_price_cents: null,
              estimated_bundle_price_cents: null,
              premium_copy: 'Quote required',
            },
          },
        ],
      }),
    ).toThrow(ApiRequestError)
  })

  it('estimates bundle pricing from anchor plus add-on', () => {
    expect(estimateBundlePrice(14900, 5900, 1000)).toBe(21800)
  })
})
