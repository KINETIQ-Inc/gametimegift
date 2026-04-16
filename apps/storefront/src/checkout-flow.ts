/**
 * Checkout flow helpers — URL construction and sessionStorage contract.
 *
 * FLOW:
 *   1. User initiates checkout for a product (navigates to /checkout).
 *   2. createCheckoutSession() → session_url returned.
 *   3. storeCheckoutSession() writes result to sessionStorage.
 *   4. Browser redirects to session_url (Stripe Checkout).
 *   5. Stripe redirects to buildSuccessUrl() or buildCancelUrl().
 *   6. App re-mounts, parseCheckoutReturn() detects the return.
 *   7. loadCheckoutSession() restores the pre-redirect state.
 *   8. Confirmation screen renders; clearCheckoutSession() called on dismiss.
 *
 * STRIPE RETURN PARAMS:
 *   Stripe preserves query params we set on successUrl. We use
 *   gtg_checkout=success to detect a confirmed payment return.
 *   We do NOT use {CHECKOUT_SESSION_ID} expansion because we store
 *   everything we need in sessionStorage before the redirect.
 */

import type { CreateCheckoutSessionResult } from '@gtg/api'

const SESSION_STORAGE_KEY = 'gtg-checkout-session-v1'
const IDEMPOTENCY_STORAGE_KEY = 'gtg-checkout-idempotency-v1'
const RETURN_PARAM = 'gtg_checkout'
const ORDER_ID_PARAM = 'order_id'
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Stored Session Contract ──────────────────────────────────────────────────

/**
 * What we capture before the Stripe redirect.
 * Restored on the confirmation screen after Stripe sends the customer back.
 */
export interface StoredCheckoutSession {
  orderId: string
  orderNumber: string
  sessionId: string
  unitId: string
  serialNumber: string
  productId: string
  sku: string
  productName: string
  /** Retail price in cents at time of checkout — for display only. */
  retailPriceCents: number
  customerName: string
  customerEmail: string
  channel: 'storefront_direct' | 'consultant_assisted'
  /** ISO 8601 timestamp — when the session was created. */
  initiatedAt: string
}

interface StoredCheckoutIdempotencyKey {
  key: string
  scope: string
  createdAt: string
}

// ─── Checkout Return Detection ────────────────────────────────────────────────

export type CheckoutReturn =
  | { kind: 'success'; orderId: string | null }
  | { kind: 'cancelled' }
  | { kind: 'none' }

/**
 * Read the checkout return state from the current URL query string.
 * Call once on app mount. Does not mutate the URL.
 */
export function parseCheckoutReturn(): CheckoutReturn {
  if (typeof window === 'undefined') return { kind: 'none' }

  const params = new URLSearchParams(window.location.search)
  const value = params.get(RETURN_PARAM)
  const orderId = params.get(ORDER_ID_PARAM)?.trim() ?? null

  if (value === 'success') {
    return {
      kind: 'success',
      orderId: orderId && UUID_RE.test(orderId) ? orderId : null,
    }
  }
  if (value === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'none' }
}

/**
 * Remove the gtg_checkout param from the URL without a page reload.
 * Call after consuming the return state to keep the URL clean.
 */
export function clearCheckoutReturn(): void {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  url.searchParams.delete(RETURN_PARAM)
  url.searchParams.delete(ORDER_ID_PARAM)
  window.history.replaceState(null, '', url.toString())
}

// ─── URL Builders ─────────────────────────────────────────────────────────────

/**
 * The URL Stripe will redirect to after a successful payment.
 * Always points to the current origin so the SPA re-mounts.
 */
export function buildSuccessUrl(): string {
  return `${window.location.origin}/?${RETURN_PARAM}=success`
}

/**
 * The URL Stripe will redirect to when the customer clicks "Back" or cancels.
 * Returns to the product detail hash so the customer can resume browsing.
 */
export function buildCancelUrl(productSku: string, productSlug: string): string {
  return `${window.location.origin}/#product/${encodeURIComponent(productSku)}/${productSlug}`
}

// ─── Session Storage ──────────────────────────────────────────────────────────

/**
 * Persist the checkout result to sessionStorage immediately before the
 * Stripe redirect. Call with the full CreateCheckoutSessionResult.
 */
export function storeCheckoutSession(
  result: CreateCheckoutSessionResult,
  customerName: string,
  customerEmail: string,
  retailPriceCents: number,
): void {
  const session: StoredCheckoutSession = {
    orderId: result.order_id,
    orderNumber: result.order_number,
    sessionId: result.session_id,
    unitId: result.unit_id,
    serialNumber: result.serial_number,
    productId: result.product_id,
    sku: result.sku,
    productName: result.product_name,
    retailPriceCents,
    customerName,
    customerEmail,
    channel: result.channel,
    initiatedAt: new Date().toISOString(),
  }

  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // sessionStorage unavailable (private browsing, quota exceeded).
    // The confirmation screen will still render with generic copy.
  }
}

/**
 * Read the stored checkout session after returning from Stripe.
 * Returns null if nothing is stored or storage is unavailable.
 */
export function loadCheckoutSession(): StoredCheckoutSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredCheckoutSession
  } catch {
    return null
  }
}

/**
 * Remove the stored session after the confirmation screen is dismissed.
 * Call in the confirmation "continue" and "verify" handlers.
 */
export function clearCheckoutSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

function createCheckoutIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `gtg-checkout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function readStoredCheckoutIdempotency(): StoredCheckoutIdempotencyKey | null {
  try {
    const raw = window.sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredCheckoutIdempotencyKey
  } catch {
    return null
  }
}

export function loadOrCreateCheckoutIdempotencyKey(scope: string): string {
  const existing = readStoredCheckoutIdempotency()
  const now = Date.now()

  if (existing && existing.scope === scope) {
    const createdAt = Date.parse(existing.createdAt)
    if (Number.isFinite(createdAt) && now - createdAt < IDEMPOTENCY_TTL_MS) {
      return existing.key
    }
  }

  const next: StoredCheckoutIdempotencyKey = {
    key: createCheckoutIdempotencyKey(),
    scope,
    createdAt: new Date(now).toISOString(),
  }

  try {
    window.sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // sessionStorage unavailable — fall back to the generated key for this request.
  }

  return next.key
}

export function clearCheckoutIdempotencyKey(): void {
  try {
    window.sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

// ─── Referral Code Detection ──────────────────────────────────────────────────

/**
 * Read a consultant referral code from the ?ref= query param.
 * Consultant referral links are formatted as: /?ref=GTG-XXXXX
 *
 * Returns null if no ?ref= param is present or if the value is empty.
 * The raw value is uppercased and trimmed — pass directly to resolveConsultantCode().
 */
export function parseReferralCode(): string | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  const value = params.get('ref')?.trim().toUpperCase()
  return value || null
}
