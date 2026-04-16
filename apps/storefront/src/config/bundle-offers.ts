import {
  buildProductBundleScaffold,
  createBundleCatalog,
  type BundleCatalog,
  type BundleOffer,
  type ProductListItem,
} from '@gtg/api'

const PARTNERSHIP_BUNDLE_CATALOG: BundleCatalog = createBundleCatalog({
  version: '2026-04-phase-7',
  offers: [
    {
      id: 'floral-partner-bundle',
      name: 'Flowers + Collectible Signature Bundle',
      headline: 'Pair With Flowers',
      summary:
        'A bouquet gets attention. Add an authenticated collectible and the gift keeps a place in the home long after the flowers are gone.',
      tag: '1-800-Flowers Compatible',
      partner_type: 'floral',
      ready_state: 'concept',
      occasions: ["Father's Day", 'Birthday delivery', 'Anniversary surprise'],
      items: [
        {
          kind: 'core_product',
          source: 'gtg',
          label: 'Licensed GTG collectible',
          description: 'Premium anchor gift selected by team or occasion.',
          quantity: 1,
        },
        {
          kind: 'partner_add_on',
          source: 'partner',
          label: 'Seasonal floral arrangement',
          description: 'Fresh flowers curated to match the gift moment.',
          quantity: 1,
        },
        {
          kind: 'insert',
          source: 'shared',
          label: 'Premium bundle message card',
          description: 'Cross-brand insert that explains the premium pairing.',
          quantity: 1,
        },
      ],
      pricing: {
        mode: 'quote_required',
        anchor_price_cents: null,
        estimated_bundle_price_cents: null,
        premium_copy: 'Quote by assortment size, seasonality, and merchandising placement.',
      },
    },
    {
      id: 'corporate-gifting-bundle',
      name: 'Corporate Milestone Bundle',
      headline: 'Corporate Gifting',
      summary:
        'Team-specific, officially licensed, and gift-ready. A strong premium layer for employee recognition and client appreciation programs.',
      tag: 'Volume Pricing Available',
      partner_type: 'corporate',
      ready_state: 'concept',
      occasions: ['Employee recognition', 'Client gift drop', 'Conference VIP kits'],
      items: [
        {
          kind: 'core_product',
          source: 'gtg',
          label: 'Team-specific GTG product',
          description: 'Premium licensed centerpiece for each recipient.',
          quantity: 1,
        },
        {
          kind: 'packaging',
          source: 'shared',
          label: 'Branded presentation packaging',
          description: 'Gift-box layer with room for company branding.',
          quantity: 1,
        },
      ],
      pricing: {
        mode: 'quote_required',
        anchor_price_cents: null,
        estimated_bundle_price_cents: null,
        premium_copy: 'Quote by volume tier, personalization, and packaging requirements.',
      },
    },
    {
      id: 'gift-box-bundle',
      name: 'Curated Gift Box Bundle',
      headline: 'Curated Gift Boxes',
      summary:
        'GTG products arrive authenticated, packaged, and certificate-included, making them easy to slot into premium gift-box programs.',
      tag: 'Drop-Ship Compatible',
      partner_type: 'gift_box',
      ready_state: 'concept',
      occasions: ['Holiday box', 'Welcome kit', 'Premium surprise-and-delight'],
      items: [
        {
          kind: 'core_product',
          source: 'gtg',
          label: 'Authenticated GTG collectible',
          description: 'Premium anchor product for the box.',
          quantity: 1,
        },
        {
          kind: 'partner_add_on',
          source: 'partner',
          label: 'Companion gift-box item',
          description: 'Snack, candle, card, or other premium pairing item.',
          quantity: 1,
        },
        {
          kind: 'insert',
          source: 'gtg',
          label: 'Authenticity certificate',
          description: 'Supports trust and premium storytelling at unbox.',
          quantity: 1,
        },
      ],
      pricing: {
        mode: 'quote_required',
        anchor_price_cents: null,
        estimated_bundle_price_cents: null,
        premium_copy: 'Quote by curation mix, shipping format, and drop-ship constraints.',
      },
    },
  ],
})

export function getPartnershipBundleCatalog(): BundleCatalog {
  return PARTNERSHIP_BUNDLE_CATALOG
}

export function getBundleStoryMoments(): Array<{ occasion: string; pairing: string }> {
  return [
    { occasion: "Father's Day", pairing: 'Licensed collectible + floral arrangement' },
    { occasion: 'Graduation', pairing: 'Hologram collectible + keepsake message card' },
    { occasion: 'Retirement', pairing: 'Legacy piece + premium presentation box' },
    { occasion: 'Coach Farewell', pairing: 'Authenticated art + engraved note insert' },
  ]
}

export function buildProductBundleShowcase(product: ProductListItem): BundleOffer[] {
  return [
    buildProductBundleScaffold({
      product,
      partnerType: 'floral',
      partnerLabel: 'Floral Partner',
      addOnLabel: 'Seasonal bouquet',
      addOnDescription: 'Fresh stems selected to complement the gift occasion.',
      addOnEstimatedPriceCents: 5900,
    }),
    buildProductBundleScaffold({
      product,
      partnerType: 'corporate',
      partnerLabel: 'Corporate Gifting Program',
      addOnLabel: 'Presentation sleeve + note card',
      addOnDescription: 'Company-branded insert layer for milestone gifting.',
      addOnEstimatedPriceCents: 2400,
    }),
  ]
}
