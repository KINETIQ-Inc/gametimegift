/**
 * Product bundle domain — RESERVED, NOT IMPLEMENTED.
 *
 * See docs/adr/0006-product-bundles-reserved.md for the full rationale.
 *
 * Type-only placeholders so a future implementation has a named landing spot.
 * Nothing here is wired into @gtg/api yet — there is no backing schema.
 */

/**
 * A curated offering combining multiple component products (e.g. a licensed
 * collectible + a flower arrangement). Inventory, royalties, and
 * serialized-unit tracking continue to operate at the individual product
 * level — a bundle is a sales/fulfillment wrapper, never a compliance unit.
 */
export interface Bundle {
  id: string
  name: string
}

/** One component product within a bundle, optionally naming a fulfillment
 * partner (see docs/adr/0009-fulfillment-partner-reserved.md). */
export interface BundleComponentLink {
  bundleId: string
  productId: string
  fulfillmentPartnerId?: string
}
