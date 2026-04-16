/**
 * GTG Edge Function — calculate-commission
 *
 * Computes the commission breakdown for a consultant-assisted order.
 * This is a read-only calculation function — it writes nothing to the database.
 * Use the output to drive the commission entry creation step (3B-3).
 *
 * ─── What this function does ──────────────────────────────────────────────────
 *
 * 1. Verifies the order exists, is in a paid/fulfilling/fulfilled status
 *    (i.e. payment has cleared), and is attributed to the given consultant.
 *
 * 2. Re-verifies consultant eligibility at calculation time. Eligibility may
 *    have changed since the pre-payment check (3B-1) — e.g. an admin suspended
 *    the account between payment confirmation and commission creation. An
 *    ineligible consultant returns eligible=false with reasons; the caller
 *    decides whether to hold or skip commission creation.
 *
 * 3. Resolves the effective commission rate (tier config or custom rate).
 *
 * 4. For each non-cancelled order line, calculates:
 *      commission_cents = round(retail_price_cents × effective_rate)
 *    using Math.round (round-half-up to nearest cent, matching standard
 *    accounting practice).
 *
 * 5. Returns the full per-line breakdown plus order-level totals.
 *    The caller uses this output directly when creating commission_entries rows.
 *
 * ─── Commission math ─────────────────────────────────────────────────────────
 *
 *   commission_cents = Math.round(retail_price_cents × effective_rate)
 *
 *   Example:
 *     retail_price_cents = 4999  (USD $49.99)
 *     effective_rate     = 0.15  (15%)
 *     commission_cents   = Math.round(4999 × 0.15)
 *                        = Math.round(749.85)
 *                        = 750  (USD $7.50)
 *
 *   All amounts are integers (cents). No floating-point totals are returned.
 *   total_commission_cents = Σ line.commission_cents (integer sum of rounded lines).
 *   This matches how commission_entries.commission_cents is stored.
 *
 * ─── Order line inclusion ─────────────────────────────────────────────────────
 *
 *   Included: 'reserved', 'shipped', 'delivered'  (active lines)
 *   Excluded: 'cancelled'                          (no sale; no commission)
 *   Note:     'returned' lines are included in the calculation output because
 *             the commission exists at point-of-sale and is reversed separately
 *             when the return is processed. This function calculates initial
 *             commissions, not net commissions after returns.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only. Called by the order processing engine after payment
 * confirmation, before commission entries are created. Not customer-facing.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/calculate-commission
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "consultant_id": "uuid", "order_id": "uuid" }
 *
 * ─── Response (eligible) ─────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": true,
 *       "consultant_id": "...",
 *       "display_name": "Jane Smith",
 *       "order_id": "...",
 *       "order_number": "GTG-20260305-000042",
 *       "commission_tier": "senior",
 *       "effective_rate": 0.15,
 *       "commission_initial_status": "earned",
 *       "tax_onboarding_complete": true,
 *       "lines": [
 *         {
 *           "order_line_id": "...",
 *           "unit_id": "...",
 *           "serial_number": "GTG-ABC123",
 *           "sku": "GTG-001",
 *           "product_name": "Army Football Jersey #12",
 *           "retail_price_cents": 4999,
 *           "commission_cents": 750,
 *           "royalty_cents": 725
 *         }
 *       ],
 *       "total_retail_cents": 4999,
 *       "total_commission_cents": 750,
 *       "ineligibility_reasons": []
 *     }
 *   }
 *
 * ─── Response (ineligible) ───────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": false,
 *       "consultant_id": "...",
 *       "display_name": "John Doe",
 *       "order_id": "...",
 *       "order_number": "GTG-20260305-000099",
 *       "commission_tier": "standard",
 *       "effective_rate": null,
 *       "commission_initial_status": null,
 *       "tax_onboarding_complete": false,
 *       "lines": [],
 *       "total_retail_cents": 0,
 *       "total_commission_cents": 0,
 *       "ineligibility_reasons": [
 *         "Consultant status is 'suspended'. Only 'active' consultants may earn commissions."
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing fields, order not paid, order not attributed to consultant)
 *   401  Unauthenticated
 *   403  Forbidden (not an admin)
 *   404  Consultant or order not found
 *   500  Internal server error (e.g. missing tier config)
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve calculate-commission --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/calculate-commission' \
 *     --header 'Authorization: Bearer <admin-jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{"consultant_id": "<uuid>", "order_id": "<uuid>"}'
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Order statuses that indicate payment has cleared and commissions may be
 * calculated. 'draft', 'pending_payment', 'payment_failed' are pre-payment;
 * 'cancelled' and 'refunded' have no commissions.
 */
const COMMISSIONABLE_ORDER_STATUSES = new Set([
  'paid',
  'fulfilling',
  'fulfilled',
  'partially_returned',
  'fully_returned',
])

/**
 * Order line statuses for which a commission is earned at point of sale.
 * 'cancelled' lines are excluded — no sale occurred.
 * 'returned' lines ARE included — the initial commission is calculated here;
 * the reversal is handled by the return-processing flow.
 */
const COMMISSIONABLE_LINE_STATUSES = new Set([
  'reserved',
  'shipped',
  'delivered',
  'returned',
])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id: string
  order_id: string
}

interface CommissionLine {
  order_line_id: string
  unit_id: string
  serial_number: string
  sku: string
  product_name: string
  retail_price_cents: number
  /** Math.round(retail_price_cents × effective_rate) */
  commission_cents: number
  /** Denormalized from order_lines.royalty_cents — informational. */
  royalty_cents: number
}

interface ResponsePayload {
  eligible: boolean
  consultant_id: string
  display_name: string
  order_id: string
  order_number: string
  commission_tier: string
  /** null when ineligible */
  effective_rate: number | null
  /** null when ineligible */
  commission_initial_status: 'earned' | 'held' | null
  tax_onboarding_complete: boolean
  /** Empty when ineligible — no lines are calculated for an ineligible consultant. */
  lines: CommissionLine[]
  total_retail_cents: number
  total_commission_cents: number
  ineligibility_reasons: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculate commission for a single line using integer arithmetic.
 *
 * Math.round implements round-half-up (e.g. 0.5 → 1), which is standard
 * accounting practice and consistent with how commission_entries stores values.
 *
 * JavaScript's Math.round operates on IEEE 754 doubles. For amounts up to
 * ~$21 million (2,147,483,647 cents), integer precision is exact.
 */
function calcCommissionCents(retailPriceCents: number, rate: number): number {
  return Math.round(retailPriceCents * rate)
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('calculate-commission', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ──────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ─────────────────────────────────────────────────────

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ───────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    if (!body.consultant_id || !uuidPattern.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID v4', 400)
    }
    if (!body.order_id || !uuidPattern.test(body.order_id)) {
      return jsonError(req, 'order_id must be a valid UUID v4', 400)
    }

    // ── Step 6: Parallel DB fetch — consultant, order, active locks ───────────
    // Three independent queries; run in parallel to minimise latency.
    // The tier config query is conditional on the consultant's tier, so it
    // runs in a second round after the consultant row is known.

    const admin = createAdminClient()

    const [consultantResult, orderResult, locksResult] = await Promise.all([
      admin
        .from('consultant_profiles')
        .select(`
          id,
          status,
          display_name,
          commission_tier,
          custom_commission_rate,
          tax_onboarding_complete
        `)
        .eq('id', body.consultant_id)
        .single(),

      admin
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          channel,
          consultant_id
        `)
        .eq('id', body.order_id)
        .single(),

      admin
        .from('lock_records')
        .select('id')
        .eq('scope', 'consultant')
        .eq('target_id', body.consultant_id)
        .eq('is_active', true),
    ])

    // ── Handle not found ──────────────────────────────────────────────────────
    if (consultantResult.error !== null) {
      if (consultantResult.error.code === 'PGRST116') {
        return jsonError(req, `Consultant not found: ${body.consultant_id}`, 404)
      }
      authedLog.error('DB error fetching consultant', { code: consultantResult.error.code })
      return jsonError(req, 'Internal server error', 500)
    }

    if (orderResult.error !== null) {
      if (orderResult.error.code === 'PGRST116') {
        return jsonError(req, `Order not found: ${body.order_id}`, 404)
      }
      authedLog.error('DB error fetching order', { code: orderResult.error.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const consultant = consultantResult.data
    const order = orderResult.data
    const activeLockCount = (locksResult.data ?? []).length

    // ── Order preconditions ───────────────────────────────────────────────────
    // These are hard errors (400), not soft ineligibility — the caller has
    // provided the wrong order or called this function too early in the flow.

    if (order.channel !== 'consultant_assisted') {
      return jsonError(
        req,
        `Order ${order.order_number} has channel '${order.channel}'. ` +
        `Commission calculation only applies to 'consultant_assisted' orders.`,
        400,
      )
    }

    if (order.consultant_id !== body.consultant_id) {
      return jsonError(
        req,
        `Order ${order.order_number} is attributed to a different consultant ` +
        `(consultant_id mismatch). Verify the correct consultant_id for this order.`,
        400,
      )
    }

    if (!COMMISSIONABLE_ORDER_STATUSES.has(order.status)) {
      return jsonError(
        req,
        `Order ${order.order_number} has status '${order.status}'. ` +
        `Commission calculation requires a paid order. ` +
        `Commissionable statuses: ${[...COMMISSIONABLE_ORDER_STATUSES].join(', ')}.`,
        400,
      )
    }

    authedLog.info('Order and consultant fetched', {
      order_number: order.order_number,
      order_status: order.status,
      consultant_status: consultant.status,
      active_lock_count: activeLockCount,
    })

    // ── Step 7: Evaluate eligibility ──────────────────────────────────────────
    // Re-evaluated at calculation time — status may have changed since 3B-1
    // was called during the pre-payment flow.

    const ineligibilityReasons: string[] = []

    if (consultant.status !== 'active') {
      ineligibilityReasons.push(
        `Consultant status is '${consultant.status}'. ` +
        `Only 'active' consultants may earn commissions.`,
      )
    }

    if (activeLockCount > 0) {
      ineligibilityReasons.push(
        `${activeLockCount} active enforcement lock(s) on this consultant account. ` +
        `Locks must be released before new commissions can be earned.`,
      )
    }

    const eligible = ineligibilityReasons.length === 0

    // ── Return early if ineligible — no lines or rate needed ─────────────────
    if (!eligible) {
      authedLog.info('Consultant ineligible', {
        consultant_id: consultant.id,
        reasons: ineligibilityReasons,
      })
      return jsonResponse(req, {
        eligible:                  false,
        consultant_id:             consultant.id,
        display_name:              consultant.display_name,
        order_id:                  order.id,
        order_number:              order.order_number,
        commission_tier:           consultant.commission_tier,
        effective_rate:            null,
        commission_initial_status: null,
        tax_onboarding_complete:   consultant.tax_onboarding_complete,
        lines:                     [],
        total_retail_cents:        0,
        total_commission_cents:    0,
        ineligibility_reasons:     ineligibilityReasons,
      } satisfies ResponsePayload)
    }

    // ── Step 8: Resolve effective commission rate ─────────────────────────────

    let effectiveRate: number

    if (consultant.commission_tier === 'custom') {
      if (consultant.custom_commission_rate === null) {
        authedLog.error('Custom tier consultant missing custom_commission_rate', {
          consultant_id: consultant.id,
        })
        return jsonError(
          req,
          `Consultant has commission_tier='custom' but custom_commission_rate is null. ` +
          `An admin must set the rate on the consultant profile before sales can be processed.`,
          500,
        )
      }
      effectiveRate = Number(consultant.custom_commission_rate)
    } else {
      const { data: tierConfig, error: tierError } = await admin
        .from('commission_tier_config')
        .select('rate')
        .eq('tier', consultant.commission_tier)
        .eq('is_active', true)
        .single()

      if (tierError !== null || tierConfig === null) {
        authedLog.error('No active commission tier config', {
          tier: consultant.commission_tier,
          code: tierError?.code,
        })
        return jsonError(
          req,
          `No active commission rate found for tier '${consultant.commission_tier}'. ` +
          `An admin must insert an active row in commission_tier_config.`,
          500,
        )
      }

      effectiveRate = Number(tierConfig.rate)
    }

    // ── Step 9: Fetch commissionable order lines ───────────────────────────────

    const { data: lines, error: linesError } = await admin
      .from('order_lines')
      .select(`
        id,
        unit_id,
        serial_number,
        sku,
        product_name,
        status,
        retail_price_cents,
        royalty_cents
      `)
      .eq('order_id', body.order_id)
      .neq('status', 'cancelled')

    if (linesError !== null) {
      authedLog.error('DB error fetching order lines', { code: linesError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    if (lines.length === 0) {
      return jsonError(
        req,
        `Order ${order.order_number} has no commissionable lines ` +
        `(all lines are cancelled or none exist).`,
        400,
      )
    }

    // ── Step 10: Calculate per-line commissions ───────────────────────────────

    const commissionLines: CommissionLine[] = []
    let totalRetailCents = 0
    let totalCommissionCents = 0

    for (const line of lines) {
      // Only include lines in commissionable statuses.
      // 'returned' is included — initial commission is calculated at sale;
      // reversal is a separate downstream operation.
      if (!COMMISSIONABLE_LINE_STATUSES.has(line.status)) {
        continue
      }

      const commissionCents = calcCommissionCents(line.retail_price_cents, effectiveRate)

      commissionLines.push({
        order_line_id:      line.id,
        unit_id:            line.unit_id,
        serial_number:      line.serial_number,
        sku:                line.sku,
        product_name:       line.product_name,
        retail_price_cents: line.retail_price_cents,
        commission_cents:   commissionCents,
        royalty_cents:      line.royalty_cents,
      })

      totalRetailCents    += line.retail_price_cents
      totalCommissionCents += commissionCents
    }

    // ── Step 11: Build and return response ────────────────────────────────────

    const commissionInitialStatus = consultant.tax_onboarding_complete ? 'earned' : 'held'

    authedLog.info('Commission calculated', {
      order_number:          order.order_number,
      line_count:            commissionLines.length,
      effective_rate:        effectiveRate,
      total_retail_cents:    totalRetailCents,
      total_commission_cents: totalCommissionCents,
      commission_initial_status: commissionInitialStatus,
    })

    return jsonResponse(req, {
      eligible:                  true,
      consultant_id:             consultant.id,
      display_name:              consultant.display_name,
      order_id:                  order.id,
      order_number:              order.order_number,
      commission_tier:           consultant.commission_tier,
      effective_rate:            effectiveRate,
      commission_initial_status: commissionInitialStatus,
      tax_onboarding_complete:   consultant.tax_onboarding_complete,
      lines:                     commissionLines,
      total_retail_cents:        totalRetailCents,
      total_commission_cents:    totalCommissionCents,
      ineligibility_reasons:     [],
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
