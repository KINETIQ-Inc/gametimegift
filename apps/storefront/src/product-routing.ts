import type { ProductListItem } from '@gtg/api'

export type LicenseFilter = 'ALL' | 'CLC' | 'ARMY' | 'NONE'
export type SportFilter = 'ALL' | 'FOOTBALL' | 'BASKETBALL' | 'SOCCER' | 'BASEBALL' | 'HOCKEY'

export interface ProductRoute {
  kind: 'home' | 'product'
  sku?: string
}

export function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const SPORT_KEYWORDS: Record<Exclude<SportFilter, 'ALL'>, readonly string[]> = {
  FOOTBALL: [
    'football',
    'ftbl',
    'pigskin',
    'quarterback',
    'touchdown',
    'tailgate',
    'game day',
    'gameday',
    'kickoff',
    'gridiron',
  ],
  BASKETBALL: [
    'basketball',
    'bball',
    'bskt',
    'hoops',
    'slam dunk',
    'three pointer',
    'three-point',
    'courtside',
    'tipoff',
  ],
  SOCCER: [
    'soccer',
    'socc',
    'futbol',
    'fútbol',
    'pitch',
    'goalkeeper',
    'striker',
  ],
  BASEBALL: [
    'baseball',
    'bsbl',
    'home run',
    'diamond',
    'slugger',
    'outfield',
    'infield',
  ],
  HOCKEY: [
    'hockey',
    'hky',
    'puck',
    'rink',
    'slap shot',
    'hat trick',
    'goalie',
  ],
}

function containsKeyword(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword))
}

export function getSportFromProduct(product: ProductListItem): SportFilter | null {
  const haystack = [
    product.name,
    product.sku,
    product.description ?? '',
    product.school ?? '',
  ]
    .join(' ')
    .toLowerCase()

  if (containsKeyword(haystack, SPORT_KEYWORDS.FOOTBALL)) return 'FOOTBALL'
  if (containsKeyword(haystack, SPORT_KEYWORDS.BASKETBALL)) return 'BASKETBALL'
  if (containsKeyword(haystack, SPORT_KEYWORDS.SOCCER)) return 'SOCCER'
  if (containsKeyword(haystack, SPORT_KEYWORDS.BASEBALL)) return 'BASEBALL'
  if (containsKeyword(haystack, SPORT_KEYWORDS.HOCKEY)) return 'HOCKEY'

  // Current storefront inventory is heavily football-led. When a licensed
  // team collectible does not explicitly name another sport yet, default it
  // into Football so the Shop → Football view remains usable instead of empty.
  if (product.license_body === 'CLC' || product.license_body === 'ARMY') {
    return 'FOOTBALL'
  }

  return null
}

export function shortenProductName(name: string): string {
  return name
    .replace(/^The University of /i, '')
    .replace(/^University of /i, '')
    .replace(/^United States /i, '')
    .replace(/ State University\b/i, ' State')
    .replace(/ University\b/i, '')
    .trim()
}

export function getProductSlug(product: ProductListItem): string {
  return slugifySegment(shortenProductName(product.name))
}

/** Hash-based href used by legacy internal anchor navigation and tests. */
export function getProductRouteHref(product: ProductListItem): string {
  return `#product/${encodeURIComponent(product.sku)}/${getProductSlug(product)}`
}

/**
 * URL path for the dedicated /product/:sku/:slug page.
 * Use this for all router <Link> and href values in the app shell.
 */
export function getProductPath(product: ProductListItem): string {
  return `/product/${encodeURIComponent(product.sku)}/${getProductSlug(product)}`
}

export function parseProductRoute(hash: string): ProductRoute {
  const normalizedHash = hash.trim()

  if (!normalizedHash.startsWith('#product/')) {
    return { kind: 'home' }
  }

  const [, rawSku = ''] = normalizedHash.split('/')
  const sku = decodeURIComponent(rawSku).trim()

  if (!sku) {
    return { kind: 'home' }
  }

  return { kind: 'product', sku }
}

export function findProductByRoute(
  products: ProductListItem[],
  route: ProductRoute,
): ProductListItem | null {
  if (route.kind !== 'product' || !route.sku) {
    return null
  }

  return products.find((product) => product.sku === route.sku) ?? null
}

export function filterProducts(
  products: ProductListItem[],
  licenseFilter: LicenseFilter,
  sportFilter: SportFilter,
): ProductListItem[] {
  return products.filter((product) => {
    const licenseMatch = licenseFilter === 'ALL' || product.license_body === licenseFilter
    const sportMatch = sportFilter === 'ALL' || getSportFromProduct(product) === sportFilter
    return licenseMatch && sportMatch
  })
}

export function getGiftOccasions(product: ProductListItem): string[] {
  const sport = getSportFromProduct(product)

  if (product.license_body === 'ARMY') {
    return ['Retirement tribute', 'Promotion milestone', 'Veteran celebration']
  }

  if (sport === 'FOOTBALL') {
    return ['Father’s Day surprise', 'Tailgate host gift', 'Season ticket kickoff']
  }

  if (sport === 'BASKETBALL') {
    return ['Coach thank-you', 'Senior night keepsake', 'Office display upgrade']
  }

  return ['Birthday gift', 'Graduation keepsake', 'Game day host moment']
}

export function getTrustHighlights(product: ProductListItem): string[] {
  const highlights = ['Officially licensed', 'Hologram-authenticated collectible', 'Gift-ready presentation']

  if (product.available_count > 0 && product.available_count <= 10) {
    highlights.push(`Only ${product.available_count} currently available`)
  }

  if (product.license_body === 'ARMY') {
    highlights.push('Built for service pride and legacy gifting')
  }

  return highlights
}

export function getProductStory(product: ProductListItem): string {
  if (product.description && product.description.trim().length > 0) {
    return product.description.trim()
  }

  if (product.license_body === 'CLC') {
    return 'A collegiate display piece created for fans, alumni, and gift moments that deserve more than standard merch.'
  }

  if (product.license_body === 'ARMY') {
    return 'A service-forward collectible designed to honor pride, memory, and milestone gifting with a more permanent feel.'
  }

  return 'A signature Game Time Gift collectible designed to feel personal the moment it is opened and display-ready long after the occasion passes.'
}
