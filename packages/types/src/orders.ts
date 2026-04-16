import type { LicenseBody } from './inventory'
import type { CommissionTier } from './consultant'

// ─── Order Status ─────────────────────────────────────────────────────────────

/**
 * Lifecycle states for an order.
 *
 *   draft → pending_payment → paid → fulfilling → fulfilled
 *                           → payment_failed → pending_payment  (retry)
 *   paid | fulfilling       → partially_returned
 *   fulfilled               → partially_returned | fully_returned
 *   any (pre-payment)       → cancelled
 *   paid | fulfilling       → refunded
 *
 * 'draft' exists to support consultant-assisted order building before
 * the customer completes payment.
 */
export type OrderStatus =
  | 'draft'              // Being assembled; no payment attempted
  | 'pending_payment'    // Payment initiated; awaiting confirmation
  | 'payment_failed'     // Payment declined or errored; may retry
  | 'paid'               // Payment confirmed; units not yet shipped
  | 'fulfilling'         // At least one unit shipped; remainder pending
  | 'fulfilled'          // All units shipped and confirmed delivered
  | 'partially_returned' // Subset of units returned; order otherwise closed
  | 'fully_returned'     // All units returned
  | 'refunded'           // Payment refunded in full (no units shipped)
  | 'cancelled'          // Voided before payment capture

// ─── Order Line Status ────────────────────────────────────────────────────────

/**
 * Per-line lifecycle, independent of the parent order's status.
 * Enables partial fulfillment and partial returns at line granularity.
 *
 *   reserved → shipped → delivered
 *   shipped  → returned
 *   delivered → returned
 *   reserved → cancelled
 */
export type OrderLineStatus =
  | 'reserved'   // SerializedUnit held; awaiting shipment
  | 'shipped'    // Carrier has the unit; not yet confirmed delivered
  | 'delivered'  // Delivery confirmed
  | 'returned'   // Unit returned; triggers commission reversal and inventory update
  | 'cancelled'  // Line removed before shipment (unit released back to available)

// ─── Payment Method ───────────────────────────────────────────────────────────

/** Payment instrument used to settle the order. */
export type PaymentMethod = 'card' | 'ach' | 'gift_card' | 'manual'

// ─── Fulfillment Channel ──────────────────────────────────────────────────────

/**
 * How the order was placed and who is responsible for fulfillment.
 * Determines consultant attribution and commission eligibility.
 */
export type FulfillmentChannel =
  | 'storefront_direct'  // Customer self-service via storefront; no consultant
  | 'consultant_assisted'// Consultant placed or facilitated the order
  | 'admin'              // Placed by an admin (test, replacement, comp)

// ─── Shipping Address ─────────────────────────────────────────────────────────

/** Destination address for physical shipment. */
export interface ShippingAddress {
  readonly recipientName: string
  readonly line1: string
  readonly line2: string | null
  readonly city: string
  /** Two-letter state/province code. */
  readonly state: string
  readonly postalCode: string
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string
  /** Optional delivery instructions. */
  readonly instructions: string | null
}

// ─── Order ────────────────────────────────────────────────────────────────────

/**
 * A customer purchase consisting of one or more serialized units.
 *
 * An Order is the top-level financial and fulfillment record.
 * It owns the payment transaction reference and the shipping address.
 * Individual units and their per-line state are tracked on OrderLine.
 *
 * Financial amounts are maintained at both the line and order level.
 * Order-level totals are the authoritative figures for payment processing
 * and royalty base calculations; line-level amounts enable per-unit
 * commission and royalty attribution.
 *
 * Consultant attribution: if channel is 'consultant_assisted', all
 * OrderLines in this order credit the same consultantId.
 * 'storefront_direct' orders have null consultantId.
 */
export interface Order {
  /** Database primary key (UUID v4). */
  readonly id: string
  /**
   * Human-readable order number shown to customers and consultants.
   * Format: GTG-YYYYMMDD-XXXXXX (zero-padded sequential suffix per day).
   * Immutable after creation.
   */
  readonly orderNumber: string
  /** Current lifecycle status. */
  status: OrderStatus
  /** How the order was placed. */
  readonly channel: FulfillmentChannel
  /**
   * Foreign key → auth.users.id — the customer who placed the order.
   * Null for guest checkouts (future phase).
   */
  readonly customerId: string | null
  /** Customer display name at time of order — denormalized. */
  readonly customerName: string
  /** Customer email at time of order — denormalized. */
  readonly customerEmail: string
  /**
   * Consultant who facilitated this order.
   * Null when channel is 'storefront_direct' or 'admin'.
   */
  readonly consultantId: string | null
  /** Denormalized consultant display name. Null when no consultant. */
  readonly consultantName: string | null
  /** Shipping destination. */
  readonly shippingAddress: ShippingAddress
  /** Payment instrument used. */
  readonly paymentMethod: PaymentMethod
  /**
   * Stripe PaymentIntent ID or equivalent gateway reference.
   * Null until payment is initiated (status leaves 'draft').
   */
  readonly paymentIntentId: string | null
  /**
   * Stripe charge ID — populated after payment capture.
   * Null until status reaches 'paid'.
   */
  readonly chargeId: string | null
  /**
   * Total retail price of all lines before discounts, in cents (USD).
   * Sum of OrderLine.retailPriceCents across all non-cancelled lines.
   */
  readonly subtotalCents: number
  /**
   * Discount amount applied in cents (USD).
   * 0 if no discount. Always non-negative.
   */
  readonly discountCents: number
  /**
   * Shipping charge in cents (USD).
   * 0 if free shipping.
   */
  readonly shippingCents: number
  /**
   * Sales tax collected in cents (USD).
   * Computed at checkout; 0 if tax-exempt or not applicable.
   */
  readonly taxCents: number
  /**
   * Total amount charged to the customer in cents (USD).
   * = subtotalCents - discountCents + shippingCents + taxCents
   * This is the amount submitted to the payment gateway.
   */
  readonly totalCents: number
  /**
   * Amount refunded in cents (USD).
   * 0 until a refund is issued. Partial refunds are supported.
   */
  refundedCents: number
  /**
   * Discount code applied to this order.
   * Null if no discount was used.
   */
  readonly discountCode: string | null
  /**
   * Internal notes added by admin or consultant.
   * Never shown to customers.
   */
  internalNotes: string | null
  /** ISO 8601 — when the order was created (entered 'draft'). */
  readonly createdAt: string
  /**
   * ISO 8601 — when payment was confirmed.
   * Null until status reaches 'paid'.
   */
  paidAt: string | null
  /**
   * ISO 8601 — when all lines reached 'delivered'.
   * Null until status reaches 'fulfilled'.
   */
  fulfilledAt: string | null
  /**
   * ISO 8601 — when the order was cancelled or refunded.
   * Null for active or completed orders.
   */
  closedAt: string | null
  /** ISO 8601 — last status change. */
  updatedAt: string
}

// ─── Order Line ───────────────────────────────────────────────────────────────

/**
 * A single serialized unit within an Order.
 *
 * One OrderLine = one SerializedUnit.
 * There is no quantity > 1 per line — every physical unit has its own line,
 * its own serial number, and its own commission and royalty obligations.
 *
 * Financial amounts are denormalized from the unit record at the time
 * the line is created. They do not change if the product price changes.
 *
 * A line's status evolves independently of sibling lines, enabling
 * partial shipment and partial return tracking.
 */
export interface OrderLine {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Foreign key → orders.id. */
  readonly orderId: string
  /**
   * Line number within the order (1-indexed).
   * Stable after creation — used in customer-facing packing slips.
   */
  readonly lineNumber: number
  /** Current line-level lifecycle status. */
  status: OrderLineStatus
  /** Foreign key → serialized_units.id. */
  readonly unitId: string
  /** Denormalized serial number. */
  readonly serialNumber: string
  /** Denormalized SKU. */
  readonly sku: string
  /** Denormalized product name. */
  readonly productName: string
  /**
   * Licensing body for this unit — denormalized.
   * Royalty attribution at line level requires this without a unit join.
   */
  readonly licenseBody: LicenseBody
  /**
   * Royalty rate for this unit at time of sale — denormalized.
   * Enables per-line royalty amount calculation in reporting.
   */
  readonly royaltyRate: number
  /**
   * Royalty amount for this line in cents (USD).
   * = retailPriceCents × royaltyRate, rounded to nearest cent.
   * Populated at order creation; used in royalty report line-item detail.
   */
  readonly royaltyCents: number
  /**
   * Retail price for this unit in cents (USD).
   * Set at order creation. Immutable — price changes do not affect
   * existing order lines.
   */
  readonly retailPriceCents: number
  /**
   * Commission tier of the consultant at time of sale — denormalized.
   * Null when channel is 'storefront_direct' or 'admin'.
   */
  readonly commissionTier: CommissionTier | null
  /**
   * Commission rate applied to this line — denormalized.
   * Null when no consultant is attributed.
   */
  readonly commissionRate: number | null
  /**
   * Commission amount for this line in cents (USD).
   * = retailPriceCents × commissionRate, rounded to nearest cent.
   * Null when no consultant is attributed.
   */
  readonly commissionCents: number | null
  /**
   * Foreign key → commission_entries.id.
   * Created when the line is confirmed sold.
   * Null until status reaches 'reserved' with a confirmed payment.
   */
  readonly commissionEntryId: string | null
  /**
   * Carrier name (e.g. 'UPS', 'USPS', 'FedEx').
   * Null until status reaches 'shipped'.
   */
  carrier: string | null
  /**
   * Carrier tracking number.
   * Null until status reaches 'shipped'.
   */
  trackingNumber: string | null
  /**
   * ISO 8601 — when the unit was handed to the carrier.
   * Null until status reaches 'shipped'.
   */
  shippedAt: string | null
  /**
   * ISO 8601 — when delivery was confirmed.
   * Null until status reaches 'delivered'.
   */
  deliveredAt: string | null
  /**
   * ISO 8601 — when the return was accepted.
   * Null unless status is 'returned'.
   */
  returnedAt: string | null
  /**
   * Reason provided for return.
   * Required when status transitions to 'returned'.
   * Null for all other statuses.
   */
  returnReason: string | null
  /** ISO 8601 — when this line was created. */
  readonly createdAt: string
  /** ISO 8601 — last status change. */
  updatedAt: string
}
