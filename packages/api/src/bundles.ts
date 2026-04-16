import type { ProductListItem } from './products'
import { ApiRequestError } from './error'

export type BundlePartnerType = 'floral' | 'corporate' | 'concierge' | 'gift_box'
export type BundleReadyState = 'concept' | 'scaffolded' | 'live'
export type BundleItemKind = 'core_product' | 'partner_add_on' | 'packaging' | 'insert'
export type BundleSource = 'gtg' | 'partner' | 'shared'
export type BundlePricingMode = 'fixed_bundle' | 'anchor_plus_add_on' | 'quote_required'

export interface BundleItemDefinition {
  kind: BundleItemKind
  source: BundleSource
  label: string
  description: string
  quantity: number
  sku?: string
}

export interface BundlePricingDefinition {
  mode: BundlePricingMode
  anchor_price_cents: number | null
  estimated_bundle_price_cents: number | null
  premium_copy: string
}

export interface BundleOffer {
  id: string
  name: string
  headline: string
  summary: string
  tag: string
  partner_type: BundlePartnerType
  ready_state: BundleReadyState
  occasions: string[]
  items: BundleItemDefinition[]
  pricing: BundlePricingDefinition
}

export interface BundleCatalog {
  version: string
  offers: BundleOffer[]
}

export interface BuildProductBundleScaffoldInput {
  product: ProductListItem
  partnerType: BundlePartnerType
  partnerLabel: string
  addOnLabel: string
  addOnDescription: string
  addOnEstimatedPriceCents?: number
  packagingLabel?: string
  insertLabel?: string
}

const VALID_PARTNER_TYPES: BundlePartnerType[] = ['floral', 'corporate', 'concierge', 'gift_box']
const VALID_READY_STATES: BundleReadyState[] = ['concept', 'scaffolded', 'live']
const VALID_ITEM_KINDS: BundleItemKind[] = ['core_product', 'partner_add_on', 'packaging', 'insert']
const VALID_SOURCES: BundleSource[] = ['gtg', 'partner', 'shared']
const VALID_PRICING_MODES: BundlePricingMode[] = [
  'fixed_bundle',
  'anchor_plus_add_on',
  'quote_required',
]

function assertNonEmpty(value: string, field: string, fnName: string): void {
  if (!value || value.trim().length === 0) {
    throw new ApiRequestError(`[GTG] ${fnName}(): ${field} is required.`, 'VALIDATION_ERROR')
  }
}

function assertPositiveInteger(value: number, field: string, fnName: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): ${field} must be a positive integer.`,
      'VALIDATION_ERROR',
    )
  }
}

function assertEnum<T extends string>(
  value: string,
  valid: readonly T[],
  field: string,
  fnName: string,
): asserts value is T {
  if (!valid.includes(value as T)) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): ${field} must be one of ${valid.join(', ')}.`,
      'VALIDATION_ERROR',
    )
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function shortenName(name: string): string {
  return name
    .replace(/^The University of /i, '')
    .replace(/^University of /i, '')
    .replace(/^United States /i, '')
    .replace(/ State University\b/i, ' State')
    .replace(/ University\b/i, '')
    .trim()
}

export function estimateBundlePrice(
  anchorPriceCents: number,
  addOnEstimatedPriceCents = 0,
  premiumLiftCents = 0,
): number {
  if (anchorPriceCents < 0 || addOnEstimatedPriceCents < 0 || premiumLiftCents < 0) {
    throw new ApiRequestError(
      '[GTG] estimateBundlePrice(): price inputs must be non-negative.',
      'VALIDATION_ERROR',
    )
  }

  return anchorPriceCents + addOnEstimatedPriceCents + premiumLiftCents
}

export function createBundleCatalog(input: BundleCatalog): BundleCatalog {
  assertNonEmpty(input.version, 'version', 'createBundleCatalog')

  if (!Array.isArray(input.offers) || input.offers.length === 0) {
    throw new ApiRequestError(
      '[GTG] createBundleCatalog(): offers must contain at least one bundle.',
      'VALIDATION_ERROR',
    )
  }

  const ids = new Set<string>()

  for (const offer of input.offers) {
    assertNonEmpty(offer.id, 'offer.id', 'createBundleCatalog')
    assertNonEmpty(offer.name, 'offer.name', 'createBundleCatalog')
    assertNonEmpty(offer.headline, 'offer.headline', 'createBundleCatalog')
    assertNonEmpty(offer.summary, 'offer.summary', 'createBundleCatalog')
    assertNonEmpty(offer.tag, 'offer.tag', 'createBundleCatalog')
    assertEnum(offer.partner_type, VALID_PARTNER_TYPES, 'offer.partner_type', 'createBundleCatalog')
    assertEnum(offer.ready_state, VALID_READY_STATES, 'offer.ready_state', 'createBundleCatalog')

    if (ids.has(offer.id)) {
      throw new ApiRequestError(
        `[GTG] createBundleCatalog(): duplicate offer id "${offer.id}".`,
        'VALIDATION_ERROR',
      )
    }
    ids.add(offer.id)

    if (!Array.isArray(offer.occasions) || offer.occasions.length === 0) {
      throw new ApiRequestError(
        `[GTG] createBundleCatalog(): offer "${offer.id}" must define at least one occasion.`,
        'VALIDATION_ERROR',
      )
    }

    if (!Array.isArray(offer.items) || offer.items.length === 0) {
      throw new ApiRequestError(
        `[GTG] createBundleCatalog(): offer "${offer.id}" must define at least one item.`,
        'VALIDATION_ERROR',
      )
    }

    for (const item of offer.items) {
      assertEnum(item.kind, VALID_ITEM_KINDS, 'offer.items.kind', 'createBundleCatalog')
      assertEnum(item.source, VALID_SOURCES, 'offer.items.source', 'createBundleCatalog')
      assertNonEmpty(item.label, 'offer.items.label', 'createBundleCatalog')
      assertNonEmpty(item.description, 'offer.items.description', 'createBundleCatalog')
      assertPositiveInteger(item.quantity, 'offer.items.quantity', 'createBundleCatalog')
    }

    assertEnum(offer.pricing.mode, VALID_PRICING_MODES, 'offer.pricing.mode', 'createBundleCatalog')
    assertNonEmpty(offer.pricing.premium_copy, 'offer.pricing.premium_copy', 'createBundleCatalog')

    if (
      offer.pricing.anchor_price_cents !== null &&
      (!Number.isInteger(offer.pricing.anchor_price_cents) || offer.pricing.anchor_price_cents < 0)
    ) {
      throw new ApiRequestError(
        `[GTG] createBundleCatalog(): offer "${offer.id}" has an invalid anchor_price_cents.`,
        'VALIDATION_ERROR',
      )
    }

    if (
      offer.pricing.estimated_bundle_price_cents !== null &&
      (!Number.isInteger(offer.pricing.estimated_bundle_price_cents) ||
        offer.pricing.estimated_bundle_price_cents < 0)
    ) {
      throw new ApiRequestError(
        `[GTG] createBundleCatalog(): offer "${offer.id}" has an invalid estimated_bundle_price_cents.`,
        'VALIDATION_ERROR',
      )
    }
  }

  return input
}

export function buildProductBundleScaffold(
  input: BuildProductBundleScaffoldInput,
): BundleOffer {
  const {
    product,
    partnerType,
    partnerLabel,
    addOnLabel,
    addOnDescription,
    addOnEstimatedPriceCents = 0,
    packagingLabel = 'Gift-ready presentation box',
    insertLabel = 'Story card + authenticity insert',
  } = input

  assertEnum(partnerType, VALID_PARTNER_TYPES, 'partnerType', 'buildProductBundleScaffold')
  assertNonEmpty(partnerLabel, 'partnerLabel', 'buildProductBundleScaffold')
  assertNonEmpty(addOnLabel, 'addOnLabel', 'buildProductBundleScaffold')
  assertNonEmpty(addOnDescription, 'addOnDescription', 'buildProductBundleScaffold')

  if (!Number.isInteger(addOnEstimatedPriceCents) || addOnEstimatedPriceCents < 0) {
    throw new ApiRequestError(
      '[GTG] buildProductBundleScaffold(): addOnEstimatedPriceCents must be a non-negative integer.',
      'VALIDATION_ERROR',
    )
  }

  const shortName = shortenName(product.name)
  const offerId = `${slugify(product.sku)}-${partnerType}-bundle`

  return {
    id: offerId,
    name: `${shortName} x ${partnerLabel}`,
    headline: `Premium ${partnerLabel} bundle built around ${shortName}.`,
    summary: `Positions ${shortName} as the premium anchor inside a bundle-ready gift experience for ${partnerLabel}.`,
    tag: `${partnerLabel} Ready`,
    partner_type: partnerType,
    ready_state: 'scaffolded',
    occasions: [
      'Premium gifting moment',
      product.license_body === 'ARMY' ? 'Legacy and service milestone' : 'Fan celebration',
      'Catalog bundle placement',
    ],
    items: [
      {
        kind: 'core_product',
        source: 'gtg',
        label: shortName,
        description: 'Primary collectible anchor product.',
        quantity: 1,
        sku: product.sku,
      },
      {
        kind: 'partner_add_on',
        source: 'partner',
        label: addOnLabel,
        description: addOnDescription,
        quantity: 1,
      },
      {
        kind: 'packaging',
        source: 'shared',
        label: packagingLabel,
        description: 'Premium packaging layer for partner-ready presentation.',
        quantity: 1,
      },
      {
        kind: 'insert',
        source: 'gtg',
        label: insertLabel,
        description: 'Supports authenticity and premium unboxing story.',
        quantity: 1,
      },
    ],
    pricing: {
      mode: 'anchor_plus_add_on',
      anchor_price_cents: product.retail_price_cents,
      estimated_bundle_price_cents: estimateBundlePrice(
        product.retail_price_cents,
        addOnEstimatedPriceCents,
      ),
      premium_copy:
        'Anchor GTG product with partner add-on for higher AOV and stronger perceived value.',
    },
  }
}
