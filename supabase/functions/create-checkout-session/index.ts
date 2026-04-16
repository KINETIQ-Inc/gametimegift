/**
 * GTG Edge Function — create-checkout-session
 *
 * Stripe Checkout Session creation with atomic unit reservation (5B-1).
 * Reserves a serialized unit for the product being purchased, then creates
 * a Stripe Checkout Session that collects payment and shipping address.
 *
 * ─── Reservation ──────────────────────────────────────────────────────────────
 *
 * Before creating the Stripe session, one available unit for the requested
 * product is atomically reserved via the reserve_unit DB function.
 * FIFO ordering (oldest received_at first) turns over inventory evenly.
 * SKIP LOCKED prevents concurrent checkouts from blocking each other —
 * each simultaneous session claims a different unit.
 *
 * The unit remains in 'reserved' status until:
 *   - Payment succeeds → webhook (5B-2) transitions it to 'sold'
 *   - Payment fails or session expires → a cleanup job releases it back
 *     to 'available' and logs a reservation_released ledger entry
 *   - Customer cancels → cancel_url redirect; same cleanup applies
 *
 * ─── Stripe session ───────────────────────────────────────────────────────────
 *
 * Mode: payment (single charge, not subscription).
 * Shipping: collected by Stripe (shipping_address_collection, US only).
 * Metadata stored on the Stripe session (accessible in webhook):
 *   unit_id, consultant_id, customer_name, channel
 *
 * ─── Fulfillment channel ──────────────────────────────────────────────────────
 *
 *   consultant_id provided  → channel = 'consultant_assisted'
 *   consultant_id omitted   → channel = 'storefront_direct'
 *
 * When consultant_id is provided, the consultant must be active with
 * tax_onboarding_complete = true (required before commission can accrue).
 *
 * ─── Order creation ───────────────────────────────────────────────────────────
 *
 * A pending_payment order is created here before Stripe session creation so the
 * checkout flow has a durable order id/order number and can safely support
 * idempotent retries. The Stripe webhook upgrades that order once payment is
 * confirmed and fills in the final payment/shipping details returned by Stripe.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * Any authenticated user (consultant, customer). No admin role required.
 * Consultants placing assisted orders use their own JWT; the consultant_id
 * body field identifies the consultant profile for commission attribution.
 *
 * ─── Environment ──────────────────────────────────────────────────────────────
 *
 *   STRIPE_SECRET_KEY   Stripe API secret key (sk_live_* or sk_test_*)
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/create-checkout-session
 *   Authorization: Bearer <user-jwt>
 *   Content-Type: application/json
 *   {
 *     "product_id":     "<uuid>",
 *     "customer_name":  "Alex Johnson",
 *     "customer_email": "alex@example.com",
 *     "success_url":    "https://app.gametimegift.com/checkout/success?session={CHECKOUT_SESSION_ID}",
 *     "cancel_url":     "https://app.gametimegift.com/checkout/cancel",
 *     "consultant_id":  "<uuid>"   // optional — omit for direct storefront purchase
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "session_id":    "cs_test_...",
 *       "session_url":   "https://checkout.stripe.com/pay/cs_test_...",
 *       "unit_id":       "<uuid>",
 *       "serial_number": "GTG-CLC-2026-0001",
 *       "product_id":    "<uuid>",
 *       "sku":           "APP-NIKE-JERSEY-M",
 *       "product_name":  "Nike Jersey — Medium",
 *       "channel":       "consultant_assisted"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or business rule violation (see message)
 *   401  Unauthenticated
 *   404  Product not found or inactive; consultant not found
 *   409  No available units for the requested product (out of stock)
 *   500  Internal server error
 */

import { handleCors, isAllowedOrigin } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'
import { cleanupFailedCheckoutAttempt } from './cleanup.ts'
import {
  isActiveIdempotencyWindow,
  resolveExistingOrderIdempotency,
  type ExistingOrderRow,
} from './idempotency.ts'
import Stripe from 'npm:stripe'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  product_id?:     string
  customer_name?:  string
  customer_email?: string
  success_url?:    string
  cancel_url?:     string
  idempotency_key?: string
  consultant_id?:  string
  discount_code?:  string
}

interface ProductRow {
  id:                 string
  sku:                string
  name:               string
  description:        string | null
  license_body:       string
  retail_price_cents: number
  is_active:          boolean
}

interface ConsultantRow {
  id:                      string
  display_name:            string
  status:                  string
  tax_onboarding_complete: boolean
}

interface ReservedUnit {
  unit_id:       string
  serial_number: string
  sku:           string
  product_name:  string
  license_body:  string
  royalty_rate:  number
}

interface ExistingUnitRow {
  id: string
  serial_number: string
  sku: string
  product_id: string
  product_name: string
}

interface CheckoutResponsePayload {
  order_id: string
  order_number: string
  session_id: string
  session_url: string
  unit_id: string
  serial_number: string
  product_id: string
  sku: string
  product_name: string
  channel: 'storefront_direct' | 'consultant_assisted'
}

async function expireCheckoutSessionSafely(
  stripe: Stripe,
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await stripe.checkout.sessions.expire(sessionId)
    log.warn('Expired Stripe checkout session after backend failure', {
      session_id: sessionId,
      ...context,
    })
  } catch (error) {
    log.error('Failed to expire Stripe checkout session after backend failure', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    })
  }
}

function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function validateRedirectUrl(urlValue: string, fieldName: 'success_url' | 'cancel_url'): string | null {
  let parsed: URL
  try {
    parsed = new URL(urlValue)
  } catch {
    return `${fieldName} must be a valid absolute URL.`
  }

  const isLocalhost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1'

  if (!isLocalhost && parsed.protocol !== 'https:') {
    return `${fieldName} must use https.`
  }

  if (!isAllowedOrigin(parsed.origin)) {
    return `${fieldName} origin '${parsed.origin}' is not allowed.`
  }

  return null
}

function withOrderIdQueryParam(urlValue: string, orderId: string): string {
  const url = new URL(urlValue)
  url.searchParams.set('order_id', orderId)
  return url.toString()
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('create-checkout-session', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    const authedLog = log.withUser(user.id)
    authedLog.info('Authenticated')

    // ── Step 4: Parse and validate request body ─────────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.product_id || !UUID_RE.test(body.product_id)) {
      return jsonError(req, 'product_id must be a valid UUID.', 400)
    }

    if (!body.customer_name || typeof body.customer_name !== 'string' ||
        body.customer_name.trim().length === 0) {
      return jsonError(req, 'customer_name is required.', 400)
    }

    if (!body.customer_email || !EMAIL_RE.test(body.customer_email.trim())) {
      return jsonError(req, 'customer_email must be a valid email address.', 400)
    }

    if (!body.success_url || typeof body.success_url !== 'string' ||
        body.success_url.trim().length === 0) {
      return jsonError(req, 'success_url is required.', 400)
    }

    if (!body.cancel_url || typeof body.cancel_url !== 'string' ||
        body.cancel_url.trim().length === 0) {
      return jsonError(req, 'cancel_url is required.', 400)
    }

    if (!body.idempotency_key || typeof body.idempotency_key !== 'string' ||
        !isValidIdempotencyKey(body.idempotency_key.trim())) {
      return jsonError(req, 'idempotency_key must be a valid request key.', 400)
    }

    if (body.consultant_id !== undefined && !UUID_RE.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID when provided.', 400)
    }

    const successUrlError = validateRedirectUrl(body.success_url.trim(), 'success_url')
    if (successUrlError) {
      return jsonError(req, successUrlError, 400)
    }

    const cancelUrlError = validateRedirectUrl(body.cancel_url.trim(), 'cancel_url')
    if (cancelUrlError) {
      return jsonError(req, cancelUrlError, 400)
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) {
      authedLog.error('STRIPE_SECRET_KEY not configured')
      return jsonError(req, 'Internal server error', 500)
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' })
    const admin = createAdminClient()
    const channel = body.consultant_id ? 'consultant_assisted' : 'storefront_direct'
    const customerEmail = body.customer_email.trim().toLowerCase()
    const customerName = body.customer_name.trim()
    const idempotencyKey = body.idempotency_key.trim()

    // ── Step 5: Verify product exists and is active ──────────────────────────────
    //
    // Use userClient so RLS applies — non-admin users see only is_active = true.
    // A 404 from userClient means either not found or inactive.

    const { data: productData, error: productError } = await userClient
      .from('products')
      .select('id, sku, name, description, license_body, retail_price_cents, is_active')
      .eq('id', body.product_id)
      .single()

    if (productError !== null || productData === null) {
      authedLog.warn('Product not found or inactive', { product_id: body.product_id })
      return jsonError(req, `Product '${body.product_id}' not found or is not active.`, 404)
    }

    const product = productData as ProductRow

    const { data: existingOrder } = await admin
      .from('orders')
      .select('id, order_number, status, customer_email, checkout_idempotency_key, checkout_idempotency_expires_at, checkout_response_cache, checkout_session_id')
      .eq('checkout_idempotency_key', idempotencyKey)
      .maybeSingle()

    if (existingOrder) {
      const existing = existingOrder as ExistingOrderRow
      const withinTtl = isActiveIdempotencyWindow(existing.checkout_idempotency_expires_at)
      const idempotencyResolution = resolveExistingOrderIdempotency(existing)

      if (idempotencyResolution.kind === 'expired') {
        authedLog.info('Existing checkout idempotency key is expired; continuing with fresh checkout creation', {
          order_id: existing.id,
          idempotency_key: idempotencyKey,
          expires_at: existing.checkout_idempotency_expires_at,
        })
      } else if (idempotencyResolution.kind === 'return_cached') {
        authedLog.info('Returning cached checkout response for idempotent request', {
          order_id: existing.id,
          order_number: existing.order_number,
          idempotency_key: idempotencyKey,
        })

        return jsonResponse(req, idempotencyResolution.cachedResponse as CheckoutResponsePayload)
      }

      if (idempotencyResolution.kind === 'reject_processed') {
        authedLog.warn('Duplicate checkout request rejected', {
          order_id: existing.id,
          status: existing.status,
          idempotency_key: idempotencyKey,
        })
        return jsonError(req, 'This checkout attempt has already been processed.', 409)
      }

      if (idempotencyResolution.kind === 'expired') {
        return jsonError(req, 'This checkout attempt expired. Please try again to start a new secure payment session.', 409)
      }

      const { data: existingUnit } = await admin
        .from('serialized_units')
        .select('id, serial_number, sku, product_id, product_name')
        .eq('order_id', existing.id)
        .maybeSingle()

      if (!existingUnit) {
        authedLog.warn('Existing checkout found without attached reserved unit', {
          order_id: existing.id,
          idempotency_key: idempotencyKey,
        })
        return jsonError(req, 'Checkout is already being prepared. Please wait a moment and try again.', 409)
      }

      const existingSession = await stripe.checkout.sessions.retrieve(existing.checkout_session_id)
      if (existingSession.url) {
        const unit = existingUnit as ExistingUnitRow
        const cachedResponse: CheckoutResponsePayload = {
          order_id: existing.id,
          order_number: existing.order_number,
          session_id: existingSession.id,
          session_url: existingSession.url,
          unit_id: unit.id,
          serial_number: unit.serial_number,
          product_id: unit.product_id,
          sku: unit.sku,
          product_name: unit.product_name,
          channel,
        }

        const { error: cacheRefreshError } = await admin
          .from('orders')
          .update({
            checkout_response_cache: cachedResponse,
          })
          .eq('id', existing.id)

        if (cacheRefreshError !== null) {
          await expireCheckoutSessionSafely(stripe, existingSession.id, authedLog, {
            order_id: existing.id,
            idempotency_key: idempotencyKey,
            stage: 'refresh_cached_response',
          })
          return jsonError(req, 'Internal server error', 500)
        }

        authedLog.info('Returning existing Stripe session for idempotent checkout request', {
          order_id: existing.id,
          order_number: existing.order_number,
          session_id: existingSession.id,
          idempotency_key: idempotencyKey,
        })

        return jsonResponse(req, cachedResponse)
      }

      authedLog.warn('Existing checkout session is no longer reusable', {
        order_id: existing.id,
        session_id: existing.checkout_session_id,
        idempotency_key: idempotencyKey,
      })
      return jsonError(req, 'Checkout is already being prepared. Please wait a moment and try again.', 409)
    }

    // ── Step 6: Verify consultant eligibility (if consultant-assisted) ────────────

    let consultant: ConsultantRow | null = null

    if (body.consultant_id) {
      const { data: consultantData, error: consultantError } = await admin
        .from('consultant_profiles')
        .select('id, display_name, status, tax_onboarding_complete')
        .eq('id', body.consultant_id)
        .single()

      if (consultantError !== null || consultantData === null) {
        authedLog.warn('Consultant not found', { consultant_id: body.consultant_id })
        return jsonError(req, `Consultant '${body.consultant_id}' not found.`, 404)
      }

      consultant = consultantData as ConsultantRow

      if (consultant.status !== 'active') {
        return jsonError(
          req,
          `Consultant '${consultant.display_name}' has status '${consultant.status}' ` +
          'and cannot facilitate sales. Only active consultants may process orders.',
          400,
        )
      }

      if (!consultant.tax_onboarding_complete) {
        return jsonError(
          req,
          `Consultant '${consultant.display_name}' has not completed tax onboarding. ` +
          'Tax onboarding must be complete before commissions can accrue on sales.',
          400,
        )
      }
    }

    // ── Step 7: Reserve a unit atomically ───────────────────────────────────────
    //
    // reserve_unit picks the oldest available unit (FIFO), transitions it to
    // 'reserved', and appends a ledger entry — all in one transaction.
    // SKIP LOCKED ensures concurrent sessions claim different units.

    authedLog.info('Reserving unit', {
      product_id:    body.product_id,
      consultant_id: body.consultant_id ?? null,
      channel,
    })

    const { data: reserveRows, error: reserveError } = await admin.rpc(
      'reserve_unit',
      {
        p_product_id:  body.product_id,
        p_reserved_by: user.id,
      },
    )

    if (reserveError !== null) {
      const gtgMatch = reserveError.message.match(/\[GTG\][^.]+\./)
      authedLog.warn('Unit reservation failed', { error: reserveError.message })

      if (reserveError.message.includes('no available units')) {
        return jsonError(
          req,
          gtgMatch ? gtgMatch[0] : `'${product.name}' is currently out of stock.`,
          409,
        )
      }
      return jsonError(req, 'Internal server error', 500)
    }

    const unit = (reserveRows as ReservedUnit[])[0]

    authedLog.info('Unit reserved', {
      unit_id:       unit.unit_id,
      serial_number: unit.serial_number,
    })

    // ── Step 8: Create pending order record ───────────────────────────────────
    //
    // Phase 2 order activation starts here: the storefront now gets a durable
    // order id/order number immediately, and the webhook upgrades that order to
    // paid once Stripe confirms the charge.

    const { data: orderNumber, error: orderNumberError } = await admin.rpc('generate_order_number')

    if (orderNumberError !== null || !orderNumber) {
      authedLog.error('Order number generation failed', { error: orderNumberError?.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const customerId = channel === 'storefront_direct' ? user.id : null
    const placeholderShippingAddress = {
      name: customerName,
      line1: '',
      line2: null,
      city: '',
      state: '',
      postal_code: '',
      country: 'US',
    }

    const { data: orderData, error: orderError } = await admin
      .from('orders')
      .insert({
        order_number: orderNumber as string,
        status: 'pending_payment',
        channel,
        customer_id: customerId,
        customer_name: customerName,
        customer_email: customerEmail,
        consultant_id: consultant?.id ?? null,
        consultant_name: consultant?.display_name ?? null,
        shipping_address: placeholderShippingAddress,
        payment_method: 'card',
        subtotal_cents: product.retail_price_cents,
        discount_cents: 0,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: product.retail_price_cents,
        discount_code: body.discount_code?.trim().toUpperCase() || null,
        checkout_idempotency_key: idempotencyKey,
        checkout_idempotency_expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      })
      .select('id, order_number')
      .single()

    if (orderError !== null || orderData === null) {
      if (orderError?.code === '23505') {
        authedLog.warn('Pending order creation hit idempotency constraint', {
          idempotency_key: idempotencyKey,
        })
        return jsonError(req, 'Checkout is already being prepared. Please wait a moment and try again.', 409)
      }
      authedLog.error('Pending order creation failed', { error: orderError?.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const order = orderData as { id: string; order_number: string }

    const { error: unitAttachError } = await admin
      .from('serialized_units')
      .update({
        order_id: order.id,
        consultant_id: consultant?.id ?? null,
        retail_price_cents: product.retail_price_cents,
      })
      .eq('id', unit.unit_id)

    if (unitAttachError !== null) {
      authedLog.error('Reserved unit could not be attached to pending order', {
        unit_id: unit.unit_id,
        order_id: order.id,
        error: unitAttachError.message,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 9: Create Stripe Checkout Session ──────────────────────────────────
    const successUrl = withOrderIdQueryParam(body.success_url.trim(), order.id)

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',

        customer_email: customerEmail,

        line_items: [
          {
            price_data: {
              currency:     'usd',
              unit_amount:  product.retail_price_cents,
              product_data: {
                name:        product.name,
                description: product.description ?? undefined,
                metadata: {
                  sku:          product.sku,
                  license_body: product.license_body,
                },
              },
            },
            quantity: 1,
          },
        ],

        // Collect shipping address during checkout (US only)
        shipping_address_collection: {
          allowed_countries: ['US'],
        },

        // Metadata available in the webhook (5B-2) for order creation.
        // user_id is the auth.users.id of the caller:
        //   storefront_direct → the customer's auth user (used as orders.customer_id)
        //   consultant_assisted → the consultant's auth user (NOT stored as customer_id)
        metadata: {
          order_id:       order.id,
          order_number:   order.order_number,
          unit_id:        unit.unit_id,
          product_id:     body.product_id,
          customer_name:  customerName,
          consultant_id:  body.consultant_id ?? '',
          channel,
          user_id:        user.id,
          idempotency_key: idempotencyKey,
        },

        success_url: successUrl,
        cancel_url:  body.cancel_url.trim(),
      }, {
        idempotencyKey,
      })
    } catch (sessionCreateError) {
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: user.id,
        log: authedLog,
        context: {
          stage: 'stripe_session_create',
          idempotency_key: idempotencyKey,
        },
      })
      authedLog.error('Stripe checkout session creation failed', {
        order_id: order.id,
        unit_id: unit.unit_id,
        idempotency_key: idempotencyKey,
        error: sessionCreateError instanceof Error ? sessionCreateError.message : String(sessionCreateError),
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const cachedResponse: CheckoutResponsePayload = {
      order_id: order.id,
      order_number: order.order_number,
      session_id: session.id,
      session_url: session.url ?? '',
      unit_id: unit.unit_id,
      serial_number: unit.serial_number,
      product_id: product.id,
      sku: product.sku,
      product_name: product.name,
      channel,
    }

    if (!cachedResponse.session_url) {
      await expireCheckoutSessionSafely(stripe, session.id, authedLog, {
        order_id: order.id,
        idempotency_key: idempotencyKey,
        stage: 'missing_session_url',
      })
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: user.id,
        log: authedLog,
        context: {
          stage: 'missing_session_url',
          idempotency_key: idempotencyKey,
        },
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const { error: checkoutSessionUpdateError } = await admin
      .from('orders')
      .update({
        checkout_response_cache: cachedResponse,
        checkout_session_id: session.id,
      })
      .eq('id', order.id)

    if (checkoutSessionUpdateError !== null) {
      await expireCheckoutSessionSafely(stripe, session.id, authedLog, {
        order_id: order.id,
        idempotency_key: idempotencyKey,
        stage: 'persist_idempotency_record',
      })
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: user.id,
        log: authedLog,
        context: {
          stage: 'persist_idempotency_record',
          idempotency_key: idempotencyKey,
        },
      })
      authedLog.error('Pending order could not store Stripe checkout session id', {
        order_id: order.id,
        session_id: session.id,
        error: checkoutSessionUpdateError.message,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('Stripe session created', {
      session_id:    session.id,
      unit_id:       unit.unit_id,
      serial_number: unit.serial_number,
      order_id:      order.id,
      order_number:  order.order_number,
      channel,
    })

    return jsonResponse(req, cachedResponse)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
