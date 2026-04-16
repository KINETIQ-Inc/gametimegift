/**
 * GTG Edge Function — associate-order-consultant
 *
 * Manual consultant attribution for an existing order (6A-2).
 * Associates a paid order with a consultant when the customer completed
 * checkout without using their referral link.
 *
 * ─── Use case ─────────────────────────────────────────────────────────────────
 *
 * A consultant facilitates a sale in person or by phone. The customer places
 * the order directly on the storefront (channel = 'storefront_direct') without
 * clicking the consultant's referral link. An admin can retroactively attribute
 * the order to the consultant, creating commission entries and updating the
 * consultant's running totals.
 *
 * ─── What this endpoint does ──────────────────────────────────────────────────
 *
 * Delegates to the associate_order_consultant DB function (migration 40), which
 * performs the full attribution atomically in a single transaction:
 *
 *   - Updates orders: channel → 'consultant_assisted', consultant_id, consultant_name
 *   - Creates one commission_entry per non-cancelled order line (status: 'earned')
 *   - Updates each order_line with commission_tier, commission_rate, commission_cents,
 *     commission_entry_id
 *   - Updates each serialized_unit's consultant_id
 *   - Credits consultant running totals (lifetime_gross_sales_cents,
 *     lifetime_commissions_cents, pending_payout_cents) via credit_consultant_sale
 *
 * ─── Commission rate resolution ───────────────────────────────────────────────
 *
 * Commission is calculated at the consultant's tier and rate AT THE TIME of manual
 * association — not at the original sale time (there was no consultant then).
 *
 *   custom tier   → uses consultant_profiles.custom_commission_rate
 *   standard tiers → fetches the active rate from commission_tier_config
 *
 * ─── Consultant eligibility ───────────────────────────────────────────────────
 *
 * The consultant must be:
 *   - status = 'active'
 *   - tax_onboarding_complete = true
 *
 * These are the same guards applied in create-checkout-session (5B-1).
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: admin, super_admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/associate-order-consultant
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "order_id":      "<uuid>",          // orders.id
 *     "consultant_id": "<uuid>",          // consultant_profiles.id
 *     "note":          "Assisted at expo" // optional — appended to internal_notes
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "order_id":               "<uuid>",
 *       "order_number":           "GTG-20260305-000042",
 *       "consultant_id":          "<uuid>",
 *       "consultant_name":        "Jane Smith",
 *       "commission_tier":        "standard",
 *       "commission_rate":        0.10,
 *       "lines_attributed":       2,
 *       "total_commission_cents": 999
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or business rule violation (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Order or consultant not found
 *   409  Order already attributed to a consultant
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  order_id?:      unknown
  consultant_id?: unknown
  note?:          unknown
}

interface ConsultantRow {
  id:                      string
  display_name:            string
  legal_first_name:        string
  legal_last_name:         string
  status:                  string
  tax_onboarding_complete: boolean
  commission_tier:         string
  custom_commission_rate:  number | null
}

interface AssociationResult {
  order_id:               string
  order_number:           string
  lines_attributed:       number
  total_commission_cents: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('associate-order-consultant', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize — admin only ──────────────────────────────────────

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) return denied

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ─────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.order_id || typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) {
      return jsonError(req, 'order_id must be a valid UUID.', 400)
    }

    if (!body.consultant_id || typeof body.consultant_id !== 'string' || !UUID_RE.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID.', 400)
    }

    if (body.note !== undefined && (typeof body.note !== 'string' || (body.note as string).trim().length === 0)) {
      return jsonError(req, 'note must be a non-empty string when provided.', 400)
    }

    const orderId      = body.order_id
    const consultantId = body.consultant_id
    const note         = typeof body.note === 'string' ? body.note.trim() : null

    // ── Step 6: Verify consultant eligibility ───────────────────────────────

    const admin = createAdminClient()

    const { data: consultantData, error: consultantError } = await admin
      .from('consultant_profiles')
      .select('id, display_name, legal_first_name, legal_last_name, status, tax_onboarding_complete, commission_tier, custom_commission_rate')
      .eq('id', consultantId)
      .single()

    if (consultantError !== null || consultantData === null) {
      authedLog.warn('Consultant not found', { consultant_id: consultantId })
      return jsonError(req, `Consultant '${consultantId}' not found.`, 404)
    }

    const consultant = consultantData as ConsultantRow

    if (consultant.status !== 'active') {
      return jsonError(
        req,
        `Consultant '${consultant.display_name}' has status '${consultant.status}' ` +
        'and cannot receive commission attribution. Only active consultants may be associated with orders.',
        400,
      )
    }

    if (!consultant.tax_onboarding_complete) {
      return jsonError(
        req,
        `Consultant '${consultant.display_name}' has not completed tax onboarding. ` +
        'Tax onboarding must be complete before commission entries can be created.',
        400,
      )
    }

    // ── Step 7: Resolve commission rate ─────────────────────────────────────
    // custom tier → rate stored on the profile
    // standard tiers → look up the currently active rate from commission_tier_config

    let commissionRate: number

    if (consultant.commission_tier === 'custom') {
      if (consultant.custom_commission_rate === null) {
        authedLog.error('Custom tier consultant has no custom_commission_rate set', {
          consultant_id: consultantId,
        })
        return jsonError(
          req,
          `Consultant '${consultant.display_name}' has commission tier 'custom' but no custom rate is set. ` +
          'Assign a custom commission rate before attributing orders to this consultant.',
          400,
        )
      }
      commissionRate = consultant.custom_commission_rate
    } else {
      const { data: tierConfig, error: tierError } = await admin
        .from('commission_tier_config')
        .select('rate')
        .eq('tier', consultant.commission_tier)
        .eq('is_active', true)
        .single()

      if (tierError !== null || tierConfig === null) {
        authedLog.error('No active commission tier config', {
          tier:  consultant.commission_tier,
          error: tierError?.message,
        })
        return jsonError(req, 'Internal server error', 500)
      }

      commissionRate = tierConfig.rate as number
    }

    const consultantLegalName = `${consultant.legal_first_name} ${consultant.legal_last_name}`

    authedLog.info('Associating order with consultant', {
      order_id:         orderId,
      consultant_id:    consultantId,
      commission_tier:  consultant.commission_tier,
      commission_rate:  commissionRate,
    })

    // ── Step 8: Call DB function — atomic multi-table attribution ────────────

    const { data: resultRows, error: rpcError } = await admin.rpc(
      'associate_order_consultant',
      {
        p_order_id:        orderId,
        p_consultant_id:   consultantId,
        p_consultant_name: consultantLegalName,
        p_commission_tier: consultant.commission_tier,
        p_commission_rate: commissionRate,
        p_performed_by:    authorized.id,
        p_note:            note,
      },
    )

    if (rpcError !== null) {
      const msg = rpcError.message

      // Surface specific business-rule violations from the DB function.
      if (msg.includes('order not found')) {
        return jsonError(req, `Order '${orderId}' not found.`, 404)
      }
      if (msg.includes('status not eligible')) {
        const match = msg.match(/has status '([^']+)'/)
        const status = match ? match[1] : 'unknown'
        return jsonError(
          req,
          `Order cannot be attributed: status '${status}' is not eligible. ` +
          'Eligible statuses: paid, fulfilling, fulfilled.',
          400,
        )
      }
      if (msg.includes('already attributed')) {
        return jsonError(
          req,
          `Order '${orderId}' is already attributed to a consultant. ` +
          'Use a correction procedure to change attribution on an already-attributed order.',
          409,
        )
      }
      if (msg.includes('no attributable lines')) {
        return jsonError(
          req,
          `Order '${orderId}' has no attributable lines — all lines are cancelled.`,
          400,
        )
      }

      authedLog.error('associate_order_consultant RPC failed', { error: msg })
      return jsonError(req, 'Internal server error', 500)
    }

    const result = ((resultRows as AssociationResult[]) ?? [])[0]

    if (!result) {
      authedLog.error('DB function returned no rows')
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('Order attributed to consultant', {
      order_id:               result.order_id,
      order_number:           result.order_number,
      consultant_id:          consultantId,
      lines_attributed:       result.lines_attributed,
      total_commission_cents: result.total_commission_cents,
    })

    return jsonResponse(req, {
      order_id:               result.order_id,
      order_number:           result.order_number,
      consultant_id:          consultant.id,
      consultant_name:        consultantLegalName,
      commission_tier:        consultant.commission_tier,
      commission_rate:        commissionRate,
      lines_attributed:       result.lines_attributed,
      total_commission_cents: result.total_commission_cents,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
