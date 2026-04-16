/**
 * GTG Edge Function — insert-commission-entries
 *
 * Creates commission_entries rows for every commissionable line on a paid
 * consultant-assisted order, and links each entry back to its order_lines row.
 *
 * This is the write-side counterpart of calculate-commission (3B-2). It re-runs
 * the full eligibility check and commission calculation internally so that the
 * insert is based on a consistent, freshly-read snapshot — not on calculation
 * output that may be stale by the time this function is called.
 *
 * ─── What this function does ──────────────────────────────────────────────────
 *
 * 1. Verifies the order exists, is paid, and is attributed to the consultant.
 * 2. Re-checks consultant eligibility (status = active, no active locks).
 *    If ineligible at insert time, returns eligible=false with reasons and
 *    creates no entries. The caller retries after the condition is resolved.
 * 3. Resolves the effective commission rate.
 * 4. Fetches commissionable order lines (all non-cancelled).
 * 5. For each line, calls create_commission_entry() DB function which:
 *      a. Inserts commission_entries with all denormalized fields stamped.
 *      b. Updates order_lines.commission_entry_id to link back.
 *      c. Returns (commission_entry_id, was_created) — idempotent if entry exists.
 * 6. Returns a per-line result summary.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * This function is safe to call multiple times for the same order. The
 * create_commission_entry DB function handles concurrent or duplicate calls by
 * returning the existing entry with was_created=false rather than inserting a
 * duplicate. A full retry returns all_created=false but is otherwise harmless.
 *
 * ─── hold_reason for 'held' commissions ──────────────────────────────────────
 *
 * When tax_onboarding_complete = false, entries are created with status='held'.
 * The hold_reason is auto-generated: "Tax onboarding incomplete — commission
 * withheld pending W-9 submission." Admins release the hold once onboarding
 * is complete by transitioning the entry to 'earned' or 'approved'.
 *
 * ─── consultant_name denormalization ─────────────────────────────────────────
 *
 * commission_entries.consultant_name stores the legal name at time of sale
 * (legal_first_name + ' ' + legal_last_name), not the display name. This is
 * the name used for 1099 reporting and must not change if the consultant later
 * updates their display name.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only. Called by the order processing engine after payment
 * confirmation, after validate-order and calculate-commission have already run.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/insert-commission-entries
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "consultant_id": "uuid", "order_id": "uuid" }
 *
 * ─── Response (eligible, entries created) ────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": true,
 *       "consultant_id": "...",
 *       "order_id": "...",
 *       "order_number": "GTG-20260305-000042",
 *       "commission_tier": "senior",
 *       "effective_rate": 0.15,
 *       "commission_initial_status": "earned",
 *       "summary": {
 *         "total_lines": 2,
 *         "created": 2,
 *         "already_existed": 0,
 *         "failed": 0,
 *         "total_commission_cents": 1500
 *       },
 *       "entries": [
 *         {
 *           "order_line_id": "...",
 *           "unit_id": "...",
 *           "serial_number": "GTG-ABC123",
 *           "commission_entry_id": "...",
 *           "commission_cents": 750,
 *           "status": "earned",
 *           "was_created": true,
 *           "error": null
 *         }
 *       ],
 *       "ineligibility_reasons": []
 *     }
 *   }
 *
 * ─── Response (ineligible — no entries created) ───────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": false,
 *       "consultant_id": "...",
 *       "order_id": "...",
 *       "order_number": "GTG-20260305-000099",
 *       "commission_tier": "standard",
 *       "effective_rate": null,
 *       "commission_initial_status": null,
 *       "summary": null,
 *       "entries": [],
 *       "ineligibility_reasons": [
 *         "Consultant status is 'suspended'. Only 'active' consultants may earn commissions."
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (wrong channel, wrong consultant, order not paid)
 *   401  Unauthenticated
 *   403  Forbidden
 *   404  Consultant or order not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMISSIONABLE_ORDER_STATUSES = new Set([
  'paid',
  'fulfilling',
  'fulfilled',
  'partially_returned',
  'fully_returned',
])

const COMMISSIONABLE_LINE_STATUSES = new Set([
  'reserved',
  'shipped',
  'delivered',
  'returned',
])

const HOLD_REASON_TAX =
  "Tax onboarding incomplete — commission withheld pending W-9 submission. " +
  "Release to 'earned' once consultant completes tax onboarding."

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id: string
  order_id: string
}

interface EntryResult {
  order_line_id: string
  unit_id: string
  serial_number: string
  commission_entry_id: string | null
  commission_cents: number
  status: string
  was_created: boolean
  error: string | null
}

interface EntrySummary {
  total_lines: number
  created: number
  already_existed: number
  failed: number
  total_commission_cents: number
}

interface ResponsePayload {
  eligible: boolean
  consultant_id: string
  order_id: string
  order_number: string
  commission_tier: string
  effective_rate: number | null
  commission_initial_status: 'earned' | 'held' | null
  summary: EntrySummary | null
  entries: EntryResult[]
  ineligibility_reasons: string[]
}

/** Row returned by create_commission_entry() DB function. */
interface CreateCommissionEntryRpcRow {
  commission_entry_id: string
  was_created: boolean
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('insert-commission-entries', req)
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

    // ── Step 6: Parallel fetch — consultant, order, active locks ──────────────

    const admin = createAdminClient()

    const [consultantResult, orderResult, locksResult] = await Promise.all([
      admin
        .from('consultant_profiles')
        .select(`
          id,
          status,
          display_name,
          legal_first_name,
          legal_last_name,
          commission_tier,
          custom_commission_rate,
          tax_onboarding_complete
        `)
        .eq('id', body.consultant_id)
        .single(),

      admin
        .from('orders')
        .select('id, order_number, status, channel, consultant_id')
        .eq('id', body.order_id)
        .single(),

      admin
        .from('lock_records')
        .select('id')
        .eq('scope', 'consultant')
        .eq('target_id', body.consultant_id)
        .eq('is_active', true),
    ])

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
    const order      = orderResult.data
    const activeLockCount = (locksResult.data ?? []).length

    // ── Order preconditions (hard 400s) ───────────────────────────────────────

    if (order.channel !== 'consultant_assisted') {
      return jsonError(
        req,
        `Order ${order.order_number} has channel '${order.channel}'. ` +
        `Commission entries only apply to 'consultant_assisted' orders.`,
        400,
      )
    }

    if (order.consultant_id !== body.consultant_id) {
      return jsonError(
        req,
        `Order ${order.order_number} is not attributed to consultant ${body.consultant_id}.`,
        400,
      )
    }

    if (!COMMISSIONABLE_ORDER_STATUSES.has(order.status)) {
      return jsonError(
        req,
        `Order ${order.order_number} has status '${order.status}'. ` +
        `Commission entries require a paid order. ` +
        `Commissionable statuses: ${[...COMMISSIONABLE_ORDER_STATUSES].join(', ')}.`,
        400,
      )
    }

    authedLog.info('Order and consultant fetched', {
      order_number:      order.order_number,
      consultant_status: consultant.status,
      active_lock_count: activeLockCount,
    })

    // ── Step 7: Eligibility check ─────────────────────────────────────────────

    const ineligibilityReasons: string[] = []

    if (consultant.status !== 'active') {
      ineligibilityReasons.push(
        `Consultant status is '${consultant.status}'. ` +
        `Only 'active' consultants may earn commissions.`,
      )
    }

    if (activeLockCount > 0) {
      ineligibilityReasons.push(
        `${activeLockCount} active enforcement lock(s) on this consultant account.`,
      )
    }

    const eligible = ineligibilityReasons.length === 0

    if (!eligible) {
      authedLog.info('Consultant ineligible — no entries created', {
        reasons: ineligibilityReasons,
      })
      return jsonResponse(req, {
        eligible:                  false,
        consultant_id:             consultant.id,
        order_id:                  order.id,
        order_number:              order.order_number,
        commission_tier:           consultant.commission_tier,
        effective_rate:            null,
        commission_initial_status: null,
        summary:                   null,
        entries:                   [],
        ineligibility_reasons:     ineligibilityReasons,
      } satisfies ResponsePayload)
    }

    // ── Step 8: Resolve effective rate ────────────────────────────────────────

    let effectiveRate: number

    if (consultant.commission_tier === 'custom') {
      if (consultant.custom_commission_rate === null) {
        authedLog.error('Custom tier consultant missing rate', { consultant_id: consultant.id })
        return jsonError(
          req,
          `Consultant has commission_tier='custom' but custom_commission_rate is null. ` +
          `An admin must set the rate before sales can be processed.`,
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
        authedLog.error('No active tier config', { tier: consultant.commission_tier })
        return jsonError(
          req,
          `No active commission rate found for tier '${consultant.commission_tier}'.`,
          500,
        )
      }

      effectiveRate = Number(tierConfig.rate)
    }

    // ── Step 9: Fetch commissionable lines ────────────────────────────────────

    const { data: lines, error: linesError } = await admin
      .from('order_lines')
      .select(`
        id,
        unit_id,
        serial_number,
        sku,
        product_name,
        status,
        retail_price_cents
      `)
      .eq('order_id', body.order_id)
      .neq('status', 'cancelled')

    if (linesError !== null) {
      authedLog.error('DB error fetching order lines', { code: linesError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const commissionableLines = (lines ?? []).filter(
      (l) => COMMISSIONABLE_LINE_STATUSES.has(l.status),
    )

    if (commissionableLines.length === 0) {
      return jsonError(
        req,
        `Order ${order.order_number} has no commissionable lines.`,
        400,
      )
    }

    // ── Step 10: Determine initial commission status and consultant name ────────

    const commissionInitialStatus: 'earned' | 'held' = consultant.tax_onboarding_complete
      ? 'earned'
      : 'held'

    // Legal name for 1099 denormalization — not display_name.
    const consultantLegalName =
      `${consultant.legal_first_name} ${consultant.legal_last_name}`.trim()

    authedLog.info('Processing lines', {
      line_count:                commissionableLines.length,
      effective_rate:            effectiveRate,
      commission_initial_status: commissionInitialStatus,
    })

    // ── Step 11: Create commission entries per line ───────────────────────────
    // Sequential — each call is one DB transaction. Per-line failure isolation:
    // a DB error on one line is caught and recorded; other lines proceed.

    const entryResults: EntryResult[] = []
    let totalCommissionCents = 0

    for (const line of commissionableLines) {
      const commissionCents = Math.round(line.retail_price_cents * effectiveRate)

      const { data: rpcData, error: rpcError } = await admin.rpc(
        'create_commission_entry',
        {
          p_consultant_id:      body.consultant_id,
          p_consultant_name:    consultantLegalName,
          p_unit_id:            line.unit_id,
          p_order_id:           body.order_id,
          p_order_line_id:      line.id,
          p_serial_number:      line.serial_number,
          p_sku:                line.sku,
          p_product_name:       line.product_name,
          p_retail_price_cents: line.retail_price_cents,
          p_commission_tier:    consultant.commission_tier,
          p_commission_rate:    effectiveRate,
          p_commission_cents:   commissionCents,
          p_status:             commissionInitialStatus,
          p_hold_reason:        commissionInitialStatus === 'held' ? HOLD_REASON_TAX : null,
        },
      )

      if (rpcError !== null) {
        const raw = rpcError.message ?? 'Unknown DB error'
        const match = raw.match(/\[GTG\][^.]+\./)
        const msg = match ? match[0] : raw

        authedLog.warn('create_commission_entry failed', {
          unit_id: line.unit_id,
          error: raw,
        })

        entryResults.push({
          order_line_id:       line.id,
          unit_id:             line.unit_id,
          serial_number:       line.serial_number,
          commission_entry_id: null,
          commission_cents:    commissionCents,
          status:              commissionInitialStatus,
          was_created:         false,
          error:               msg,
        })
        continue
      }

      const row = (rpcData as CreateCommissionEntryRpcRow[] | null)?.[0]

      if (row == null) {
        authedLog.error('create_commission_entry returned no rows', { unit_id: line.unit_id })
        entryResults.push({
          order_line_id:       line.id,
          unit_id:             line.unit_id,
          serial_number:       line.serial_number,
          commission_entry_id: null,
          commission_cents:    commissionCents,
          status:              commissionInitialStatus,
          was_created:         false,
          error:               'DB function returned no rows — check server logs.',
        })
        continue
      }

      totalCommissionCents += commissionCents

      authedLog.info('Commission entry recorded', {
        unit_id:             line.unit_id,
        commission_entry_id: row.commission_entry_id,
        was_created:         row.was_created,
        commission_cents:    commissionCents,
      })

      entryResults.push({
        order_line_id:       line.id,
        unit_id:             line.unit_id,
        serial_number:       line.serial_number,
        commission_entry_id: row.commission_entry_id,
        commission_cents:    commissionCents,
        status:              commissionInitialStatus,
        was_created:         row.was_created,
        error:               null,
      })
    }

    // ── Step 12: Build summary and respond ────────────────────────────────────

    const created        = entryResults.filter((r) => r.error === null && r.was_created).length
    const alreadyExisted = entryResults.filter((r) => r.error === null && !r.was_created).length
    const failed         = entryResults.filter((r) => r.error !== null).length

    const summary: EntrySummary = {
      total_lines:            entryResults.length,
      created,
      already_existed:        alreadyExisted,
      failed,
      total_commission_cents: totalCommissionCents,
    }

    authedLog.info('Commission entry operation complete', {
      order_number:          order.order_number,
      created,
      already_existed:       alreadyExisted,
      failed,
      total_commission_cents: totalCommissionCents,
    })

    return jsonResponse(req, {
      eligible:                  true,
      consultant_id:             consultant.id,
      order_id:                  order.id,
      order_number:              order.order_number,
      commission_tier:           consultant.commission_tier,
      effective_rate:            effectiveRate,
      commission_initial_status: commissionInitialStatus,
      summary,
      entries:                   entryResults,
      ineligibility_reasons:     [],
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
