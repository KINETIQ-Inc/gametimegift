/**
 * Fulfillment partner domain — RESERVED, NOT IMPLEMENTED.
 *
 * See docs/adr/0009-fulfillment-partner-reserved.md for the full rationale.
 *
 * Type-only placeholders so a future implementation has a named landing spot.
 * Nothing here is wired into @gtg/api yet — there is no backing schema.
 */

/**
 * An entity that fulfills orders or bundle components: internal fulfillment,
 * a floral partner, print-on-demand apparel, a warehouse partner, etc.
 */
export interface FulfillmentPartner {
  id: string
  name: string
}

/** Which fulfillment partner is responsible for a given product or bundle
 * component. */
export interface FulfillmentAssignment {
  fulfillmentPartnerId: string
  productId: string
}
