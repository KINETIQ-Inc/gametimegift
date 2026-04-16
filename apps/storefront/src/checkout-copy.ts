/**
 * checkout-copy.ts — Canonical copy strings for the entire checkout flow.
 *
 * All user-facing checkout and confirmation messages are defined here.
 * Change copy in one place; every state stays consistent.
 *
 * ─── PHASE 2 ORDER SCHEMA (LOCKED) ───────────────────────────────────────────
 *
 * API REQUEST PAYLOAD (sent to createOrder / create-checkout-session):
 *
 *   productId       string   — UUID of the product
 *   quantity        1        — always 1; serialized units are sold one per order
 *   consultantId    string?  — resolved UUID of the consultant; NOT the raw code.
 *                              CheckoutPage resolves the raw code via
 *                              resolveConsultantCode() before this field is set.
 *
 * SESSION / DISPLAY CONTRACT (captured before the Stripe redirect, not in payload):
 *
 *   priceCents      number   — retail price in cents at time of purchase.
 *                              Display only — the server is price-authoritative.
 *                              Stored in sessionStorage via storeCheckoutSession()
 *                              so the confirmation screen can show the correct price
 *                              without a round-trip.
 *
 * UI-ONLY FIELD (never sent to the API):
 *
 *   consultantCode  string?  — raw referral code entered by the customer
 *                              (e.g. "GTG-SELLER1"). Resolved to consultantId
 *                              (UUID) in CheckoutPage before the API call.
 *                              Only lives in component state; not part of the
 *                              order record or session storage.
 */

// ─── Order Schema ─────────────────────────────────────────────────────────────

/**
 * Canonical API payload for Phase 2 order initiation.
 * These are the fields sent to createOrder() / create-checkout-session.
 */
export interface CheckoutOrderSchema {
  /** UUID of the product being purchased. */
  productId: string
  /** Always 1 — serialized collectibles are sold one unit per order. */
  quantity: 1
  /**
   * Resolved consultant UUID. The UI collects a raw referral code (e.g. "GTG-SELLER1")
   * which CheckoutPage resolves to this UUID via resolveConsultantCode() before
   * calling createOrder(). The raw code is never sent to the API.
   */
  consultantId?: string
}

/**
 * Display / session contract — captured before the Stripe redirect.
 * Stored in sessionStorage so the confirmation screen can show order details
 * without a round-trip. priceCents is display-only; the server is authoritative.
 */
export interface CheckoutSessionDisplayContract {
  priceCents: number
  productName: string
  serialNumber: string
  orderNumber: string
  customerEmail: string
}

// ─── Loading State ────────────────────────────────────────────────────────────

export const CHECKOUT_SUBMITTING = 'Preparing your order\u2026'

// ─── Validation Errors ────────────────────────────────────────────────────────

export const ERR_NAME_REQUIRED = 'Please enter your name.'
export const ERR_EMAIL_INVALID = 'Please enter a valid email address.'

export function errConsultantNotFound(code: string): string {
  return `Consultant code \u201c${code}\u201d was not found. Leave it blank to continue without a referral.`
}

// ─── API / Network Error ──────────────────────────────────────────────────────

/**
 * Exact failure message shown when the checkout API call fails.
 * Displayed inside AlertBanner kind="error". Paired with ERR_CHECKOUT_RETRY
 * as a second line so the customer knows the submit button is live again.
 */
export const ERR_CHECKOUT_FAILED =
  'Checkout could not be started. Check your connection and try again.'

/**
 * Explicit retry prompt shown below ERR_CHECKOUT_FAILED.
 * Makes it unambiguous that the customer can fix their details and resubmit —
 * rather than leaving them wondering if the button will work again.
 */
export const ERR_CHECKOUT_RETRY = 'Fix the details above and tap the button to try again.'

// ─── Success Messages (OrderConfirmation) ─────────────────────────────────────

/**
 * Shown once the webhook has processed and the order status has advanced
 * beyond pending_payment (syncPhase === 'ready').
 */
export const SUCCESS_CONFIRMED =
  'Your gift is registered, hologram-authenticated, and ready to ship. ' +
  'Keep the serial number above \u2014 it\u2019s your permanent proof of authenticity.'

/**
 * Shown while polling detects the order is still at pending_payment
 * (Stripe webhook not yet processed). Payment IS confirmed.
 */
export const SUCCESS_SYNCING =
  'Payment confirmed. We\u2019re finalizing your order now\u2026'

/**
 * Shown when 6 polling attempts are exhausted and the order has not advanced.
 * Payment went through; the delay is backend processing, not a failure.
 */
export const SUCCESS_SYNC_DELAYED =
  'Your payment went through, but order confirmation is delayed. ' +
  'Check your email for details, or contact support with your order number.'

/**
 * Shown when sessionStorage was unavailable (private browsing, storage cleared).
 * No order-specific details are available; copy is generic but honest.
 */
export const SUCCESS_FALLBACK =
  'Your order was received and your gift is being prepared for shipment. ' +
  'A confirmation email is on its way.'
