import type { ProductListItem } from '@gtg/api'
import { FEATURED_SHOWCASE_ITEMS } from './featured-product-art'

const MOCK_TIMESTAMP = '2026-04-05T00:00:00.000Z'

function toSchoolName(name: string): string {
  return name.replace(/\s+Collector\s+.*/i, '').trim()
}

export const DEV_MOCK_STOREFRONT_PRODUCTS: ProductListItem[] = FEATURED_SHOWCASE_ITEMS.map((item) => ({
  id: `mock-${item.id}`,
  sku: item.sku,
  name: item.name,
  description: item.description,
  school: toSchoolName(item.name),
  license_body: item.license_body,
  retail_price_cents: item.retail_price_cents,
  available_count: item.available_count,
  in_stock: item.in_stock,
  created_at: MOCK_TIMESTAMP,
  updated_at: MOCK_TIMESTAMP,
}))
