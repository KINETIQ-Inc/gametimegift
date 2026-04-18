import Stripe from 'npm:stripe'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, getUserFromRequest } from '../_shared/supabase.ts'
import { cleanupFailedCheckoutAttempt } from '../create-checkout-session/cleanup.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000

interface RequestBody {
  product_id?: string
  quantity?: number
  customer_name?: string
  customer_email?: string
  idempotency_key?: string
  consultant_id?: string
  discount_code?: string
}

interface ProductRow {
  id: string
  sku: string
  name: string
  license_body: string
  retail_price_cents: number
  active: boolean
}

interface ConsultantRow {
  id: string
  display_name: string
  status: string
  tax_onboarding_complete: boolean
}

interface ReservedUnit {
  unit_id: string
  serial_number: string
  sku: string
  product_name: string
  license_body: string
  royalty_rate: number
}

interface ExistingOrderRow {
  id: string
  order_number: string
  status: string
  payment_intent_id: string | null
  checkout_idempotency_expires_at: string | null
  checkout_response_cache: Record<string, unknown> | null
}

interface ExistingUnitRow {
  id: string
  serial_number: string
  sku: string
  product_id: string
  product_name: string
}

interface CreateOrderResponsePayload {
  order_id: string
  order_number: string
  payment_intent_id: string
  client_secret: string
  total_cents: number
  unit_id: string
  serial_number: string
  product_id: string
  sku: string
  product_name: string
  channel: 'storefront_direct' | 'consultant_assisted'
}

function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function isActiveIdempotencyWindow(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) && parsed > now
}

async function cancelPaymentIntentSafely(
  stripe: Stripe,
  paymentIntentId: string,
  log: ReturnType<typeof createLogger>,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId)
    log.warn('Cancelled Stripe payment intent after backend failure', {
      payment_intent_id: paymentIntentId,
      ...context,
    })
  } catch (error) {
    log.error('Failed to cancel Stripe payment intent after backend failure', {
      payment_intent_id: paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    })
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const log = createLogger('create-order', req)
  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.product_id || !UUID_RE.test(body.product_id)) {
      return jsonError(req, 'product_id must be a valid UUID.', 400)
    }
    if (body.quantity !== undefined && body.quantity !== 1) {
      return jsonError(req, 'quantity must be 1 for serialized collectibles.', 400)
    }
    if (!body.customer_name || body.customer_name.trim().length === 0) {
      return jsonError(req, 'customer_name is required.', 400)
    }
    if (!body.customer_email || !EMAIL_RE.test(body.customer_email.trim())) {
      return jsonError(req, 'customer_email must be a valid email address.', 400)
    }
    if (
      !body.idempotency_key ||
      typeof body.idempotency_key !== 'string' ||
      !isValidIdempotencyKey(body.idempotency_key.trim())
    ) {
      return jsonError(req, 'idempotency_key must be a valid request key.', 400)
    }
    if (body.consultant_id !== undefined && !UUID_RE.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID when provided.', 400)
    }

    const authHeader = req.headers.get('authorization') ?? '(none)'
    const tokenPreview = authHeader.length > 20 ? authHeader.slice(0, 20) + '...' : authHeader
    log.info('Auth header received', {
      token_preview: tokenPreview,
      has_bearer: authHeader.toLowerCase().startsWith('bearer '),
      consultant_assisted: !!body.consultant_id,
    })

    const { data: { user }, error: authError } = await getUserFromRequest(req)
    const authenticatedUserId = authError || !user ? null : user.id
    const serviceAccountId = Deno.env.get('GTG_SERVICE_ACCOUNT_ID')

    if (body.consultant_id && !authenticatedUserId) {
      log.warn('Authentication required for consultant-assisted checkout', { error: authError?.message })
      return unauthorized(req)
    }

    if (!authenticatedUserId && !serviceAccountId) {
      log.error('GTG_SERVICE_ACCOUNT_ID not configured for guest checkout')
      return jsonError(req, 'Internal server error', 500)
    }

    const actorUserId = authenticatedUserId ?? serviceAccountId!
    const authedLog = log.withUser(actorUserId)
    authedLog.info('Checkout actor resolved', {
      guest_checkout: !authenticatedUserId,
      consultant_assisted: !!body.consultant_id,
    })

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) {
      authedLog.error('STRIPE_SECRET_KEY not configured')
      return jsonError(req, 'Internal server error', 500)
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' })
    const admin = createAdminClient()
    const channel = body.consultant_id ? 'consultant_assisted' : 'storefront_direct'
    const customerName = body.customer_name.trim()
    const customerEmail = body.customer_email.trim().toLowerCase()
    const idempotencyKey = body.idempotency_key.trim()

    const { data: productData, error: productError } = await admin
      .from('products')
      .select('id, sku, name, license_body:license_type, retail_price_cents:price, active')
      .eq('id', body.product_id)
      .eq('active', true)
      .single()

    if (productError || !productData) {
      authedLog.warn('Product not found or inactive', { product_id: body.product_id })
      return jsonError(req, `Product '${body.product_id}' not found or is not active.`, 404)
    }

    const product = productData as ProductRow

    const { data: existingOrder } = await admin
      .from('orders')
      .select('id, order_number, status, payment_intent_id, checkout_idempotency_expires_at, checkout_response_cache')
      .eq('checkout_idempotency_key', idempotencyKey)
      .maybeSingle()

    if (existingOrder) {
      const existing = existingOrder as ExistingOrderRow
      if (!isActiveIdempotencyWindow(existing.checkout_idempotency_expires_at)) {
        return jsonError(req, 'This checkout attempt expired. Please try again.', 409)
      }

      if (existing.checkout_response_cache) {
        return jsonResponse(req, existing.checkout_response_cache as CreateOrderResponsePayload)
      }

      if (!existing.payment_intent_id || existing.status !== 'pending_payment') {
        return jsonError(req, 'This checkout attempt has already been processed.', 409)
      }

      const paymentIntent = await stripe.paymentIntents.retrieve(existing.payment_intent_id)
      if (!paymentIntent.client_secret) {
        return jsonError(req, 'Checkout is already being prepared. Please wait a moment and try again.', 409)
      }

      const { data: existingUnit } = await admin
        .from('serialized_units')
        .select('id, serial_number, sku, product_id, product_name')
        .eq('order_id', existing.id)
        .maybeSingle()

      if (!existingUnit) {
        return jsonError(req, 'Checkout is already being prepared. Please wait a moment and try again.', 409)
      }

      const unit = existingUnit as ExistingUnitRow
      const cachedResponse: CreateOrderResponsePayload = {
        order_id: existing.id,
        order_number: existing.order_number,
        payment_intent_id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        total_cents: paymentIntent.amount,
        unit_id: unit.id,
        serial_number: unit.serial_number,
        product_id: unit.product_id,
        sku: unit.sku,
        product_name: unit.product_name,
        channel,
      }

      await admin
        .from('orders')
        .update({ checkout_response_cache: cachedResponse })
        .eq('id', existing.id)

      return jsonResponse(req, cachedResponse)
    }

    let consultant: ConsultantRow | null = null
    if (body.consultant_id) {
      const { data: consultantData, error: consultantError } = await admin
        .from('consultant_profiles')
        .select('id, display_name, status, tax_onboarding_complete')
        .eq('id', body.consultant_id)
        .single()

      if (consultantError || !consultantData) {
        return jsonError(req, `Consultant '${body.consultant_id}' not found.`, 404)
      }

      consultant = consultantData as ConsultantRow
      if (consultant.status !== 'active') {
        return jsonError(
          req,
          `Consultant '${consultant.display_name}' has status '${consultant.status}' and cannot facilitate sales.`,
          400,
        )
      }
      if (!consultant.tax_onboarding_complete) {
        return jsonError(
          req,
          `Consultant '${consultant.display_name}' has not completed tax onboarding.`,
          400,
        )
      }
    }

    const { data: reserveRows, error: reserveError } = await admin.rpc('reserve_unit', {
      p_product_id: body.product_id,
      p_reserved_by: actorUserId,
    })

    if (reserveError) {
      if (reserveError.message.includes('no available units')) {
        return jsonError(req, `'${product.name}' is currently out of stock.`, 409)
      }
      authedLog.error('Unit reservation failed', { error: reserveError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const unit = (reserveRows as ReservedUnit[])[0]

    const { data: orderNumber, error: orderNumberError } = await admin.rpc('generate_order_number')
    if (orderNumberError || !orderNumber) {
      authedLog.error('Order number generation failed', {
        error: orderNumberError?.message ?? 'generate_order_number returned no value',
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const totalCents = product.retail_price_cents
    const customerId = channel === 'storefront_direct' ? authenticatedUserId : null
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
        subtotal_cents: totalCents,
        discount_cents: 0,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: totalCents,
        discount_code: body.discount_code?.trim().toUpperCase() || null,
        checkout_idempotency_key: idempotencyKey,
        checkout_idempotency_expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      })
      .select('id, order_number')
      .single()

    if (orderError || !orderData) {
      authedLog.error('Order insert failed', {
        error: orderError?.message ?? 'orders insert returned no row',
        channel,
        customer_id: customerId,
        consultant_id: consultant?.id ?? null,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const order = orderData as { id: string; order_number: string }

    const { error: unitAttachError } = await admin
      .from('serialized_units')
      .update({
        order_id: order.id,
        consultant_id: consultant?.id ?? null,
        retail_price_cents: totalCents,
      })
      .eq('id', unit.unit_id)

    if (unitAttachError) {
      authedLog.error('Reserved unit attach failed', {
        order_id: order.id,
        unit_id: unit.unit_id,
        error: unitAttachError.message,
      })
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: actorUserId,
        log: authedLog,
        context: { stage: 'attach_reserved_unit', idempotency_key: idempotencyKey },
      })
      return jsonError(req, 'Internal server error', 500)
    }

    let paymentIntent: Stripe.PaymentIntent
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: totalCents,
        currency: 'usd',
        receipt_email: customerEmail,
        automatic_payment_methods: { enabled: true },
        metadata: {
          order_id: order.id,
          order_number: order.order_number,
          unit_id: unit.unit_id,
          product_id: product.id,
          customer_name: customerName,
          consultant_id: body.consultant_id ?? '',
          channel,
          user_id: authenticatedUserId ?? '',
          idempotency_key: idempotencyKey,
        },
      }, {
        idempotencyKey,
      })
    } catch (error) {
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: actorUserId,
        log: authedLog,
        context: { stage: 'stripe_payment_intent_create', idempotency_key: idempotencyKey },
      })
      authedLog.error('Stripe payment intent creation failed', {
        order_id: order.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return jsonError(req, 'Internal server error', 500)
    }

    if (!paymentIntent.client_secret) {
      authedLog.error('Stripe payment intent missing client secret', {
        order_id: order.id,
        payment_intent_id: paymentIntent.id,
      })
      await cancelPaymentIntentSafely(stripe, paymentIntent.id, authedLog, {
        order_id: order.id,
        stage: 'missing_client_secret',
      })
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: actorUserId,
        log: authedLog,
        context: { stage: 'missing_client_secret', idempotency_key: idempotencyKey },
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const cachedResponse: CreateOrderResponsePayload = {
      order_id: order.id,
      order_number: order.order_number,
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      total_cents: totalCents,
      unit_id: unit.unit_id,
      serial_number: unit.serial_number,
      product_id: product.id,
      sku: product.sku,
      product_name: product.name,
      channel,
    }

    const { error: persistError } = await admin
      .from('orders')
      .update({
        payment_intent_id: paymentIntent.id,
        checkout_response_cache: cachedResponse,
      })
      .eq('id', order.id)

    if (persistError) {
      authedLog.error('Persisting payment intent failed', {
        order_id: order.id,
        payment_intent_id: paymentIntent.id,
        error: persistError.message,
      })
      await cancelPaymentIntentSafely(stripe, paymentIntent.id, authedLog, {
        order_id: order.id,
        stage: 'persist_payment_intent',
      })
      await cleanupFailedCheckoutAttempt({
        admin,
        unitId: unit.unit_id,
        orderId: order.id,
        releasedBy: actorUserId,
        log: authedLog,
        context: { stage: 'persist_payment_intent', idempotency_key: idempotencyKey },
      })
      return jsonError(req, 'Internal server error', 500)
    }

    if ((Deno.env.get('APP_ENV') ?? 'development') !== 'production') {
      authedLog.info('Order created', {
        order_id: order.id,
        order_number: order.order_number,
        product_id: product.id,
        total_cents: totalCents,
      })
    }

    return jsonResponse(req, cachedResponse)
  } catch (error) {
    log.error('Unhandled error', {
      message: error instanceof Error ? error.message : String(error),
    })
    return jsonError(req, 'Internal server error', 500)
  }
})
