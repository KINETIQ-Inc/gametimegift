/**
 * GTG Edge Function — stripe-webhook
 *
 * Stripe webhook handler for checkout.session.completed (5B-2).
 * Processes confirmed Stripe payments by creating the order, order_line,
 * selling the reserved unit, and recording the commission and payment event.
 *
 * ─── Webhook event handled ────────────────────────────────────────────────────
 *
 * checkout.session.completed
 *   Fired by Stripe when a Checkout Session payment is confirmed.
 *   The session carries the metadata set in create-checkout-session (5B-1):
 *     unit_id, product_id, customer_name, consultant_id, channel, user_id
 *
 * All other event types are acknowledged with 200 and ignored. Stripe requires
 * a 2xx response within 30 seconds or it will retry the delivery.
 *
 * ─── Processing sequence ──────────────────────────────────────────────────────
 *
 *   1. Verify Stripe webhook signature (HMAC-SHA256 via stripe.webhooks.constructEventAsync)
 *   2. Check event type — skip non-checkout events
 *   3. Idempotency guard — check payment_events.stripe_event_id; skip if found
 *   4. Partial-failure recovery — check order_lines.unit_id; if order exists,
 *      write payment_event only and return 200
 *   5. Fetch unit details (admin client — bypasses RLS on serialized_units)
 *   6. If consultant-assisted: fetch consultant profile + active tier rate
 *   7. Retrieve Stripe PaymentIntent for charge_id (PI expand latest_charge)
 *   8. Generate order number (generate_order_number DB function — atomic)
 *   9. Create order record (status='paid', payment_method='card')
 *  10. Create order_line record (denormalized unit/royalty/commission fields)
 *  11. sell_unit RPC — transitions reserved → sold, appends ledger entry
 *  12. If consultant-assisted: create commission_entry, link to order_line,
 *      credit consultant running totals (credit_consultant_sale RPC)
 *  13. Record payment_event — charge_succeeded (idempotency anchor)
 *
 * ─── Idempotency ──────────────────────────────────────────────────────────────
 *
 * The payment_event row (written last) is the idempotency anchor keyed on
 * stripe_event_id. On Stripe webhook replay:
 *   - If payment_event exists → already fully processed; return 200.
 *   - If order_line exists but no payment_event → partial failure on prior run;
 *     write the missing payment_event and return 200.
 *   - Otherwise → first delivery; run full sequence.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * This endpoint is NOT behind user JWT authentication. It is authenticated
 * exclusively by Stripe webhook signature verification. All DB operations use
 * the admin client (service role), which bypasses RLS.
 *
 * ─── Environment ──────────────────────────────────────────────────────────────
 *
 *   STRIPE_SECRET_KEY        Stripe API secret key (sk_live_* or sk_test_*)
 *   STRIPE_WEBHOOK_SECRET    Stripe webhook signing secret (whsec_*)
 *   GTG_SERVICE_ACCOUNT_ID   UUID of a GTG service account in auth.users.
 *                            Used as performed_by on payment_events and ledger
 *                            entries triggered by this automated handler.
 *                            Must be created in Supabase Auth before deploying.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/stripe-webhook
 *   Content-Type: application/json
 *   Stripe-Signature: t=...,v1=...
 *   (Raw Stripe event JSON body)
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "received":     true,
 *       "order_id":     "<uuid>",      // present on new order creation
 *       "order_number": "GTG-YYYYMMDD-XXXXXX"
 *     }
 *   }
 *
 *   200 { "data": { "received": true } }  // non-checkout events, already-processed
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Missing or invalid Stripe-Signature
 *   500  Internal server error (DB failure, missing env, Stripe API error)
 *
 * Note: Stripe retries on any non-2xx response. Return 500 only for errors that
 * may self-resolve on retry (transient DB issues). For permanent errors (missing
 * metadata), log and return 200 to prevent infinite Stripe retries.
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse } from '../_shared/response.ts'
import { createAdminClient } from '../_shared/supabase.ts'
import Stripe from 'npm:stripe'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionMetadata {
  order_id?:      string
  order_number?:  string
  unit_id?:       string
  product_id?:    string
  customer_name?: string
  consultant_id?: string
  channel?:       string
  user_id?:       string
}

interface UnitRow {
  id:            string
  serial_number: string
  sku:           string
  product_name:  string
  status:        string
  license_body:  string
  royalty_rate:  number
}

interface ConsultantRow {
  id:                   string
  display_name:         string
  legal_first_name:     string
  legal_last_name:      string
  commission_tier:      string
  custom_commission_rate: number | null
}

interface ProcessOrderLedgerResponse {
  success: boolean
  status: 'completed' | 'failed'
  failed_step?: string
  errors?: Array<{ code: string; message: string }>
}

async function processOrderLedger(
  orderId: string,
  log: ReturnType<typeof createLogger>,
): Promise<{ ok: true; status: 'completed' | 'failed' } | { ok: false; error: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    return { ok: false, error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' }
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/process-order-ledger`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      order_id: orderId,
      internal_source: 'stripe-webhook',
    }),
  })

  if (!response.ok) {
    const details = await response.text()
    return {
      ok: false,
      error: `process-order-ledger invocation failed (${response.status}): ${details}`,
    }
  }

  let payload: { data?: ProcessOrderLedgerResponse } | null = null
  try {
    payload = await response.json() as { data?: ProcessOrderLedgerResponse }
  } catch {
    return { ok: false, error: 'process-order-ledger returned invalid JSON response' }
  }

  if (!payload?.data) {
    return { ok: false, error: 'process-order-ledger returned malformed response payload' }
  }

  if (!payload.data.success) {
    const step = payload.data.failed_step ?? 'unknown'
    const errors = payload.data.errors ?? []
    log.error('process-order-ledger returned failure', {
      order_id: orderId,
      failed_step: step,
      errors,
    })
    return {
      ok: false,
      error: `process-order-ledger reported failed status at step '${step}'`,
    }
  }

  return { ok: true, status: payload.data.status }
}

// ─── Helper ────────────────────────────────────────────────────────────────────

/** Build a shipping address object from a Stripe address + name. */
function buildShippingAddress(
  address: Stripe.Address | null | undefined,
  name:    string | null | undefined,
  fallbackName: string,
): Record<string, unknown> {
  return {
    name:        name        ?? fallbackName,
    line1:       address?.line1       ?? '',
    line2:       address?.line2       ?? null,
    city:        address?.city        ?? '',
    state:       address?.state       ?? '',
    postal_code: address?.postal_code ?? '',
    country:     address?.country     ?? 'US',
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('stripe-webhook', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Read raw body ────────────────────────────────────────────────
    // Must read as text before any JSON parsing — Stripe signature verification
    // requires the exact raw bytes Stripe sent.

    const rawBody = await req.text()

    // ── Step 4: Validate environment ────────────────────────────────────────

    const stripeKey        = Deno.env.get('STRIPE_SECRET_KEY')
    const webhookSecret    = Deno.env.get('STRIPE_WEBHOOK_SECRET')
    const serviceAccountId = Deno.env.get('GTG_SERVICE_ACCOUNT_ID')

    if (!stripeKey || !webhookSecret || !serviceAccountId) {
      log.error('Missing required environment variables', {
        has_stripe_key:        !!stripeKey,
        has_webhook_secret:    !!webhookSecret,
        has_service_account:   !!serviceAccountId,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' })

    // ── Step 5: Verify Stripe webhook signature ──────────────────────────────
    // constructEventAsync uses the Web Crypto API (available in Deno).
    // Returns 400 on invalid signature so Stripe can alert on misconfiguration.

    const signature = req.headers.get('stripe-signature')
    if (!signature) {
      log.warn('Missing Stripe-Signature header')
      return jsonError(req, 'Missing Stripe-Signature header', 400)
    }

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret)
    } catch (err) {
      log.warn('Stripe signature verification failed', { error: String(err) })
      return jsonError(req, 'Invalid webhook signature', 400)
    }

    log.info('Stripe event received', { event_id: event.id, type: event.type })

    // ── Step 6: Filter event type ────────────────────────────────────────────
    // Only checkout.session.completed triggers order creation.
    // All other event types are acknowledged and ignored.

    if (event.type !== 'checkout.session.completed') {
      log.info('Ignoring event type (not handled)', { type: event.type })
      return jsonResponse(req, { received: true })
    }

    const session = event.data.object as Stripe.Checkout.Session

    // Skip sessions where payment did not succeed (e.g. free sessions).
    if (session.payment_status !== 'paid') {
      log.warn('Session payment_status is not paid; skipping', {
        payment_status: session.payment_status,
        session_id:     session.id,
      })
      return jsonResponse(req, { received: true })
    }

    // ── Step 7: Extract session metadata ────────────────────────────────────

    const meta         = (session.metadata ?? {}) as SessionMetadata
    const orderIdFromMeta = meta.order_id ?? null
    const unitId       = meta.unit_id
    const consultantId = meta.consultant_id || null
    const channel      = (meta.channel ?? 'storefront_direct') as 'storefront_direct' | 'consultant_assisted'
    const customerName = meta.customer_name ?? session.customer_details?.name ?? ''
    const metaUserId   = meta.user_id ?? null

    if (!unitId) {
      // Missing unit_id means the session was not created by our Edge Function.
      // Log and return 200 to avoid infinite Stripe retries — this cannot self-heal.
      log.error('Missing unit_id in session metadata; cannot process', { session_id: session.id })
      return jsonResponse(req, { received: true })
    }

    const customerEmail = (session.customer_details?.email ?? session.customer_email ?? '').toLowerCase()

    log.info('Processing checkout.session.completed', {
      session_id:     session.id,
      order_id:       orderIdFromMeta,
      unit_id:        unitId,
      channel,
      has_consultant: !!consultantId,
    })

    const admin = createAdminClient()

    // ── Step 8: Idempotency guard ────────────────────────────────────────────
    // payment_events.stripe_event_id is UNIQUE — a duplicate Stripe delivery
    // would violate this constraint. Check before any writes.

    const { data: existingPaymentEvent } = await admin
      .from('payment_events')
      .select('id')
      .eq('stripe_event_id', event.id)
      .maybeSingle()

    if (existingPaymentEvent) {
      log.info('Event already fully processed (idempotent); skipping', { event_id: event.id })
      return jsonResponse(req, { received: true })
    }

    // ── Step 9: Partial-failure recovery ────────────────────────────────────
    // If the prior run created the order_line but failed before writing the
    // payment_event, we can complete the run by writing just the payment_event.

    const { data: existingOrderLine } = await admin
      .from('order_lines')
      .select('id, order_id')
      .eq('unit_id', unitId)
      .maybeSingle()

    if (existingOrderLine) {
      log.warn('Order already created for unit (partial failure recovery); writing payment_event only', {
        unit_id:  unitId,
        order_id: existingOrderLine.order_id,
      })

      // Fetch the order for denormalized fields required by payment_events.
      const { data: existingOrder } = await admin
        .from('orders')
        .select('id, order_number, total_cents, payment_intent_id, charge_id')
        .eq('id', existingOrderLine.order_id)
        .single()

      if (existingOrder) {
        await admin.from('payment_events').insert({
          order_id:                 existingOrder.id,
          order_number:             existingOrder.order_number,
          customer_email:           customerEmail,
          payment_method:           'card',
          event_type:               'charge_succeeded',
          amount_cents:             existingOrder.total_cents,
          stripe_event_id:          event.id,
          stripe_payment_intent_id: existingOrder.payment_intent_id ?? null,
          stripe_charge_id:         existingOrder.charge_id ?? null,
          performed_by:             serviceAccountId,
          description:              `Payment received for order ${existingOrder.order_number}`,
        })
      }

      return jsonResponse(req, { received: true })
    }

    // ── Step 10: Fetch unit details ──────────────────────────────────────────
    // Admin client needed — serialized_units RLS restricts non-admin callers.

    const { data: unitData, error: unitError } = await admin
      .from('serialized_units')
      .select('id, serial_number, sku, product_name, status, license_body, royalty_rate')
      .eq('id', unitId)
      .single()

    if (unitError !== null || unitData === null) {
      log.error('Unit not found', { unit_id: unitId, error: unitError?.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const unit = unitData as UnitRow

    if (unit.status !== 'reserved') {
      // Unexpected — the unit should be reserved. Log and return 200 to avoid
      // infinite retries; this requires manual investigation.
      log.error('Unit is not in reserved status; cannot sell', {
        unit_id: unitId,
        status:  unit.status,
      })
      return jsonResponse(req, { received: true })
    }

    // ── Step 11: Fetch consultant + commission rate (if applicable) ───────────

    let consultant:     ConsultantRow | null = null
    let commissionRate: number        | null = null

    if (consultantId) {
      const { data: consultantData, error: consultantError } = await admin
        .from('consultant_profiles')
        .select('id, display_name, legal_first_name, legal_last_name, commission_tier, custom_commission_rate')
        .eq('id', consultantId)
        .single()

      if (consultantError !== null || consultantData === null) {
        log.error('Consultant not found', { consultant_id: consultantId, error: consultantError?.message })
        return jsonError(req, 'Internal server error', 500)
      }

      consultant = consultantData as ConsultantRow

      if (consultant.commission_tier === 'custom') {
        // Custom tier: rate is stored directly on the consultant profile.
        commissionRate = consultant.custom_commission_rate
      } else {
        // Standard tier: look up the active rate in commission_tier_config.
        const { data: tierConfig, error: tierError } = await admin
          .from('commission_tier_config')
          .select('rate')
          .eq('tier', consultant.commission_tier)
          .eq('is_active', true)
          .single()

        if (tierError !== null || tierConfig === null) {
          log.error('No active commission tier config for tier', {
            tier:  consultant.commission_tier,
            error: tierError?.message,
          })
          return jsonError(req, 'Internal server error', 500)
        }

        commissionRate = tierConfig.rate as number
      }
    }

    // ── Step 12: Retrieve PaymentIntent for charge_id ────────────────────────
    // expand: ['latest_charge'] surfaces the charge object so we can store
    // the Stripe charge ID on the order and payment_event for reconciliation.

    let paymentIntentId: string | null = null
    let chargeId:        string | null = null

    if (session.payment_intent) {
      const piId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent.id

      try {
        const pi = await stripe.paymentIntents.retrieve(piId, {
          expand: ['latest_charge'],
        })
        paymentIntentId = pi.id
        chargeId        = (pi.latest_charge as Stripe.Charge | null)?.id ?? null
      } catch (err) {
        // Non-fatal: store the PI ID we have; charge_id will be null.
        log.warn('Could not retrieve PaymentIntent; charge_id will be null', {
          pi_id: piId,
          error: String(err),
        })
        paymentIntentId = piId
      }
    }

    // ── Step 13: Extract financials from Stripe session ──────────────────────
    // amount_subtotal = sum of line item prices before discounts, tax, shipping.
    // For our sessions (single item, qty=1), amount_subtotal = retail_price_cents.

    const retailPriceCents = session.amount_subtotal ?? 0
    const totalCents       = session.amount_total    ?? 0
    const discountCents    = session.total_details?.amount_discount ?? 0
    const shippingCents    = session.total_details?.amount_shipping ?? 0
    const taxCents         = session.total_details?.amount_tax      ?? 0

    // Compute royalty and commission amounts at the captured price.
    const royaltyCents    = Math.round(retailPriceCents * Number(unit.royalty_rate))
    const commissionCents = commissionRate !== null
      ? Math.round(retailPriceCents * Number(commissionRate))
      : null

    // Build shipping address from Stripe shipping_details.
    const shippingAddress = buildShippingAddress(
      session.shipping_details?.address,
      session.shipping_details?.name,
      customerName,
    )

    // customer_id: only set for storefront_direct (the caller IS the customer).
    // For consultant_assisted, meta.user_id is the consultant's auth user.
    const customerId: string | null = channel === 'storefront_direct' ? (metaUserId ?? null) : null

    // ── Step 14: Create or update order ──────────────────────────────────────

    let order: { id: string; order_number: string } | null = null

    if (orderIdFromMeta) {
      const { data: updatedOrder, error: updateOrderError } = await admin
        .from('orders')
        .update({
          status: 'paid',
          customer_name: customerName,
          customer_email: customerEmail,
          consultant_id: consultantId,
          consultant_name: consultant?.display_name ?? null,
          shipping_address: shippingAddress,
          payment_method: 'card',
          payment_intent_id: paymentIntentId,
          charge_id: chargeId,
          subtotal_cents: retailPriceCents,
          discount_cents: discountCents,
          shipping_cents: shippingCents,
          tax_cents: taxCents,
          total_cents: totalCents,
          paid_at: new Date().toISOString(),
        })
        .eq('id', orderIdFromMeta)
        .select('id, order_number')
        .single()

      if (updateOrderError !== null || updatedOrder === null) {
        log.error('Pending order update failed', {
          order_id: orderIdFromMeta,
          error: updateOrderError?.message,
        })
        return jsonError(req, 'Internal server error', 500)
      }

      order = updatedOrder as { id: string; order_number: string }
      log.info('Pending order promoted to paid', {
        order_id: order.id,
        order_number: order.order_number,
      })
    } else {
      const { data: orderNumber, error: orderNumberError } = await admin.rpc('generate_order_number')

      if (orderNumberError !== null || !orderNumber) {
        log.error('Order number generation failed', { error: orderNumberError?.message })
        return jsonError(req, 'Internal server error', 500)
      }

      const { data: createdOrder, error: orderError } = await admin
        .from('orders')
        .insert({
          order_number:      orderNumber as string,
          status:            'paid',
          channel,
          customer_id:       customerId,
          customer_name:     customerName,
          customer_email:    customerEmail,
          consultant_id:     consultantId,
          consultant_name:   consultant?.display_name ?? null,
          shipping_address:  shippingAddress,
          payment_method:    'card',
          payment_intent_id: paymentIntentId,
          charge_id:         chargeId,
          subtotal_cents:    retailPriceCents,
          discount_cents:    discountCents,
          shipping_cents:    shippingCents,
          tax_cents:         taxCents,
          total_cents:       totalCents,
          paid_at:           new Date().toISOString(),
        })
        .select('id, order_number')
        .single()

      if (orderError !== null || createdOrder === null) {
        log.error('Order creation failed', { error: orderError?.message })
        return jsonError(req, 'Internal server error', 500)
      }

      order = createdOrder as { id: string; order_number: string }
      log.info('Order created', { order_id: order.id, order_number: order.order_number })
    }

    // ── Step 15: Create order_line ───────────────────────────────────────────
    // commission_entry_id is null at creation; linked after commission_entries
    // insert below. The FK was added in migration 9.

    if (order === null) {
      log.error('Order resolution failed before order_line creation')
      return jsonError(req, 'Internal server error', 500)
    }

    const { data: orderLine, error: orderLineError } = await admin
      .from('order_lines')
      .insert({
        order_id:           order.id,
        line_number:        1,
        status:             'reserved',
        unit_id:            unitId,
        serial_number:      unit.serial_number,
        sku:                unit.sku,
        product_name:       unit.product_name,
        license_body:       unit.license_body,
        royalty_rate:       unit.royalty_rate,
        royalty_cents:      royaltyCents,
        retail_price_cents: retailPriceCents,
        commission_tier:    consultant?.commission_tier   ?? null,
        commission_rate:    commissionRate                ?? null,
        commission_cents:   commissionCents               ?? null,
      })
      .select('id')
      .single()

    if (orderLineError !== null || orderLine === null) {
      log.error('Order line creation failed', { error: orderLineError?.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 17: Trigger process-order-ledger pipeline ───────────────────────
    // Webhook now delegates all sell/commission/royalty ledger processing to
    // the canonical server-side pipeline.

    const processResult = await processOrderLedger(order.id, log)
    if (!processResult.ok) {
      log.error('process-order-ledger execution failed', {
        order_id: order.id,
        error: processResult.error,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    log.info('process-order-ledger completed', {
      order_id: order.id,
      status: processResult.status,
    })

    // ── Step 19: Record payment_event (charge_succeeded) ────────────────────
    // Written last — this is the idempotency anchor. If this write succeeds,
    // the entire sequence is considered complete. Replay via Stripe will be
    // caught by the payment_events.stripe_event_id unique constraint check.

    const { error: paymentEventError } = await admin
      .from('payment_events')
      .insert({
        order_id:                 order.id,
        order_number:             order.order_number,
        customer_email:           customerEmail,
        payment_method:           'card',
        event_type:               'charge_succeeded',
        amount_cents:             totalCents,
        stripe_event_id:          event.id,
        stripe_payment_intent_id: paymentIntentId,
        stripe_charge_id:         chargeId,
        performed_by:             serviceAccountId,
        description:              `Payment received for order ${order.order_number}`,
      })

    if (paymentEventError !== null) {
      log.error('Payment event creation failed', { error: paymentEventError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    log.info('Checkout complete', {
      order_id:            order.id,
      order_number:        order.order_number,
      unit_id:             unitId,
      channel,
      commission_entry_id: null,
    })

    return jsonResponse(req, {
      received:     true,
      order_id:     order.id,
      order_number: order.order_number,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
