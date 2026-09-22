import type { ProductListItem } from '@gtg/api'

// Relative — resolves against whatever domain actually serves the built app
// (localhost, a preview deploy, or production), rather than hardcoding
// gametimegift.com. The files themselves live in
// apps/storefront/public/assets/products/, which Vite copies verbatim into
// the build output at this same path.
const PRODUCT_ASSET_BASE_URL = '/assets/products'
const PRODUCT_ASSET_VERSION = '2026-03-31'

function productAssetPath(filename: string): string {
  return `${PRODUCT_ASSET_BASE_URL}/${filename}?v=${PRODUCT_ASSET_VERSION}`
}

export interface FeaturedProductArtConfig {
  keywords: string[]
  assetPath: string
  artPadding: string
}

export interface FeaturedShowcaseItem {
  id: string
  name: string
  sku: string
  license_body: 'CLC' | 'ARMY'
  retail_price_cents: number
  available_count: number
  in_stock: boolean
  description: string
  assetPath: string
  artPadding: string
}

// Filtered to schools GTG currently holds a license for (see
// @gtg/domain's licensed-schools.ts, the single source of truth), plus the
// generic United States Army entry (license_body 'ARMY', not a CLC school).
const FEATURED_ART_SEQUENCE: FeaturedProductArtConfig[] = [
  { keywords: ['alabama'], assetPath: productAssetPath('alabama.png'), artPadding: '5%' },
  { keywords: ['louisiana state', 'lsu'], assetPath: productAssetPath('lsu.png'), artPadding: '5%' },
  { keywords: ['clemson'], assetPath: productAssetPath('clemson.png'), artPadding: '4%' },
  { keywords: ['florida'], assetPath: productAssetPath('florida.png'), artPadding: '5%' },
  { keywords: ['south carolina'], assetPath: productAssetPath('south-carolina.png'), artPadding: '5%' },
  { keywords: ['michigan state'], assetPath: productAssetPath('michigan-state.png'), artPadding: '6%' },
  { keywords: ['maryland'], assetPath: productAssetPath('maryland.png'), artPadding: '5%' },
  { keywords: ['naval academy', 'navy'], assetPath: productAssetPath('naval-academy.png'), artPadding: '5%' },
  { keywords: ['united states army'], assetPath: productAssetPath('united-states-army.png'), artPadding: '6%' },
  { keywords: ['north carolina a&t', 'north carolina at'], assetPath: productAssetPath('north-carolina-at.png'), artPadding: '5%' },
]

export const FEATURED_SHOWCASE_ITEMS: FeaturedShowcaseItem[] = [
  {
    id: 'showcase-alabama',
    name: 'The University of Alabama Collector Football',
    sku: 'BAMA-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 6,
    in_stock: true,
    description: 'Signature crimson styling with a softer metallic accent for a strong but readable slide.',
    assetPath: productAssetPath('alabama.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-lsu',
    name: 'Louisiana State University Collector Football',
    sku: 'LSU-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 5,
    in_stock: true,
    description: 'Purple and gold collector finish made to create strong contrast in the lineup.',
    assetPath: productAssetPath('lsu.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-clemson',
    name: 'Clemson University Collector Football',
    sku: 'CLEM-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 4,
    in_stock: true,
    description: 'Bold orange and purple presentation piece designed to break up lighter products in the carousel.',
    assetPath: productAssetPath('clemson.png'),
    artPadding: '4%',
  },
  {
    id: 'showcase-florida',
    name: 'University of Florida Collector Football',
    sku: 'UF-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 6,
    in_stock: true,
    description: 'Blue and orange finish that keeps the middle of the carousel energetic and high-contrast.',
    assetPath: productAssetPath('florida.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-south-carolina',
    name: 'University of South Carolina Collector Football',
    sku: 'SC-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 5,
    in_stock: true,
    description: 'Dark garnet finish that closes the lineup with a strong, grounded visual anchor.',
    assetPath: productAssetPath('south-carolina.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-michigan-state',
    name: 'Michigan State University Collector Football',
    sku: 'MSU-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 5,
    in_stock: true,
    description: 'Crisp white and green presentation that keeps lighter products spaced cleanly through the set.',
    assetPath: productAssetPath('michigan-state.png'),
    artPadding: '6%',
  },
  {
    id: 'showcase-maryland',
    name: 'University of Maryland Collector Football',
    sku: 'UMD-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 4,
    in_stock: true,
    description: 'Red-and-gold team finish that broadens the warm-color section without duplicating Alabama or Louisville.',
    assetPath: productAssetPath('maryland.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-naval-academy',
    name: 'United States Naval Academy Collector Football',
    sku: 'NAVY-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 4,
    in_stock: true,
    description: 'Rich navy and gold display piece that deepens the lineup without letting blue products bunch up.',
    assetPath: productAssetPath('naval-academy.png'),
    artPadding: '5%',
  },
  {
    id: 'showcase-united-states-army',
    name: 'United States Army Collector Football',
    sku: 'ARMY-FTBL',
    license_body: 'ARMY',
    retail_price_cents: 13999,
    available_count: 6,
    in_stock: true,
    description: 'Neutral khaki finish that gives the eye a reset between brighter collegiate colorways.',
    assetPath: productAssetPath('united-states-army.png'),
    artPadding: '6%',
  },
  {
    id: 'showcase-north-carolina-at',
    name: 'North Carolina A&T State University Collector Football',
    sku: 'NCAT-FTBL',
    license_body: 'CLC',
    retail_price_cents: 13999,
    available_count: 4,
    in_stock: true,
    description: 'Golden finish with navy accents that brings warmth and brightness into the rotation.',
    assetPath: productAssetPath('north-carolina-at.png'),
    artPadding: '5%',
  },
]

function normalize(value: string): string {
  return value.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim()
}

export function getFeaturedProductArt(product: ProductListItem): FeaturedProductArtConfig | null {
  const name = normalize(product.name)

  return (
    FEATURED_ART_SEQUENCE.find((entry) =>
      entry.keywords.some((keyword) => name.includes(normalize(keyword))),
    ) ?? null
  )
}

export function orderFeaturedProducts(products: ProductListItem[]): ProductListItem[] {
  const ranked = products
    .map((product, index) => {
      const art = getFeaturedProductArt(product)
      const order = art ? FEATURED_ART_SEQUENCE.findIndex((entry) => entry.assetPath === art.assetPath) : Number.MAX_SAFE_INTEGER

      return {
        product,
        index,
        order,
      }
    })
    .sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order
      return left.index - right.index
    })

  return ranked.map((entry) => entry.product)
}
