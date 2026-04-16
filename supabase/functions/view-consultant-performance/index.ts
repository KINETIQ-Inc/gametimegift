/**
 * GTG Edge Function — view-consultant-performance
 *
 * Commission performance report for a single consultant (4C-3).
 * Read-only — no writes. Returns the consultant's profile snapshot,
 * full commission entry history, and a computed summary breakdown.
 *
 * ─── Data sources ─────────────────────────────────────────────────────────────
 *
 *   consultant_profiles   Profile snapshot with running totals and tier.
 *                         Running totals (lifetime_gross_sales_cents,
 *                         lifetime_commissions_cents, pending_payout_cents)
 *                         are the authoritative fast-read figures — not
 *                         recomputed from commission_entries on every call.
 *
 *   commission_entries    One row per sold unit. Ordered newest-first.
 *                         Filtered by year_month when provided.
 *                         The summary block is computed from the returned
 *                         entries — it reflects the filtered view, not the
 *                         full lifetime totals.
 *
 * ─── Filtering ────────────────────────────────────────────────────────────────
 *
 * When year_month is omitted, all commission entries are returned.
 * When year_month is provided (YYYY-MM), only entries created in that calendar
 * month (UTC) are returned, and the summary reflects that period only.
 * The consultant profile snapshot (running totals) always reflects the full
 * lifetime regardless of year_month — it is not filtered.
 *
 * ─── Commission statuses ──────────────────────────────────────────────────────
 *
 * earned   → Sale completed; pending approval
 * held     → Withheld (suspension, fraud review)
 * approved → Cleared for payout
 * paid     → Disbursed
 * reversed → Clawed back (return, confirmed fraud)
 * voided   → Invalidated by system correction
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Performance data includes commission amounts and payout linkage.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/view-consultant-performance
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   All-time:       { "consultant_id": "<uuid>" }
 *   Monthly filter: { "consultant_id": "<uuid>", "year_month": "2026-03" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "consultant": {
 *         "id":                         "<uuid>",
 *         "auth_user_id":               "<uuid>",
 *         "status":                     "active",
 *         "legal_first_name":           "Jane",
 *         "legal_last_name":            "Smith",
 *         "display_name":               "Jane S.",
 *         "email":                      "jane@example.com",
 *         "phone":                      null,
 *         "tax_onboarding_complete":    true,
 *         "commission_tier":            "standard",
 *         "custom_commission_rate":     null,
 *         "referred_by":                null,
 *         "lifetime_gross_sales_cents": 249900,
 *         "lifetime_commissions_cents": 24990,
 *         "pending_payout_cents":       14994,
 *         "activated_at":               "2026-01-15T...",
 *         "last_sale_at":               "2026-03-05T...",
 *         "created_at":                 "2026-01-10T...",
 *         "updated_at":                 "2026-03-05T..."
 *       },
 *       "summary": {
 *         "year_month":         "2026-03",   // null when no filter applied
 *         "total_entries":      12,
 *         "earned_count":       2,
 *         "earned_cents":       998,
 *         "held_count":         0,
 *         "held_cents":         0,
 *         "approved_count":     3,
 *         "approved_cents":     1497,
 *         "paid_count":         6,
 *         "paid_cents":         2994,
 *         "reversed_count":     1,
 *         "reversed_cents":     499,
 *         "voided_count":       0,
 *         "voided_cents":       0,
 *         "net_earned_cents":   5489   // earned + held + approved — not reversed/voided
 *       },
 *       "commissions": [
 *         {
 *           "id":                "<uuid>",
 *           "order_id":          "<uuid>",
 *           "unit_id":           "<uuid>",
 *           "serial_number":     "GTG-CLC-2026-0001",
 *           "sku":               "APP-NIKE-JERSEY-M",
 *           "product_name":      "Nike Jersey — Medium",
 *           "retail_price_cents": 4999,
 *           "commission_tier":   "standard",
 *           "commission_rate":   0.10,
 *           "commission_cents":  499,
 *           "status":            "approved",
 *           "hold_reason":       null,
 *           "reversal_reason":   null,
 *           "payout_batch_id":   null,
 *           "approved_at":       "2026-03-04T...",
 *           "approved_by":       "<uuid>",
 *           "paid_at":           null,
 *           "reversed_at":       null,
 *           "created_at":        "2026-03-03T...",
 *           "updated_at":        "2026-03-04T..."
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Consultant not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Consultant profile columns — tax_id excluded (compliance contract)
const CONSULTANT_SELECT =
  'id, auth_user_id, status, ' +
  'legal_first_name, legal_last_name, display_name, ' +
  'email, phone, ' +
  'tax_onboarding_complete, ' +
  'commission_tier, custom_commission_rate, referred_by, ' +
  'lifetime_gross_sales_cents, lifetime_commissions_cents, pending_payout_cents, ' +
  'activated_at, last_sale_at, ' +
  'status_changed_at, status_changed_by, status_change_reason, ' +
  'created_at, updated_at'

// Commission entry columns (consultant_name omitted — redundant in per-consultant view)
const COMMISSION_SELECT =
  'id, order_id, unit_id, ' +
  'serial_number, sku, product_name, ' +
  'retail_price_cents, commission_tier, commission_rate, commission_cents, ' +
  'status, hold_reason, reversal_reason, ' +
  'payout_batch_id, approved_at, approved_by, paid_at, reversed_at, ' +
  'created_at, updated_at'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id?: string
  year_month?:    string
}

interface CommissionEntry {
  commission_cents: number
  status:           string
}

interface Summary {
  year_month:       string | null
  total_entries:    number
  earned_count:     number
  earned_cents:     number
  held_count:       number
  held_cents:       number
  approved_count:   number
  approved_cents:   number
  paid_count:       number
  paid_cents:       number
  reversed_count:   number
  reversed_cents:   number
  voided_count:     number
  voided_cents:     number
  net_earned_cents: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSummary(entries: CommissionEntry[], yearMonth: string | null): Summary {
  const summary: Summary = {
    year_month:       yearMonth,
    total_entries:    entries.length,
    earned_count:     0,
    earned_cents:     0,
    held_count:       0,
    held_cents:       0,
    approved_count:   0,
    approved_cents:   0,
    paid_count:       0,
    paid_cents:       0,
    reversed_count:   0,
    reversed_cents:   0,
    voided_count:     0,
    voided_cents:     0,
    net_earned_cents: 0,
  }

  for (const entry of entries) {
    const cents = entry.commission_cents
    switch (entry.status) {
      case 'earned':
        summary.earned_count++
        summary.earned_cents += cents
        break
      case 'held':
        summary.held_count++
        summary.held_cents += cents
        break
      case 'approved':
        summary.approved_count++
        summary.approved_cents += cents
        break
      case 'paid':
        summary.paid_count++
        summary.paid_cents += cents
        break
      case 'reversed':
        summary.reversed_count++
        summary.reversed_cents += cents
        break
      case 'voided':
        summary.voided_count++
        summary.voided_cents += cents
        break
    }
  }

  // Net earned = amounts still owed to the consultant (earned + held + approved)
  // Paid is already disbursed; reversed and voided are cancelled obligations
  summary.net_earned_cents =
    summary.earned_cents + summary.held_cents + summary.approved_cents

  return summary
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('view-consultant-performance', req)
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

    // ── Step 4: Authorize ───────────────────────────────────────────────────────

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ─────────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.consultant_id || !UUID_RE.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID.', 400)
    }

    let yearMonth: string | null = null

    if (body.year_month !== undefined) {
      if (typeof body.year_month !== 'string' || !YEAR_MONTH_RE.test(body.year_month)) {
        return jsonError(
          req,
          "year_month must be in YYYY-MM format (e.g. '2026-03').",
          400,
        )
      }
      yearMonth = body.year_month
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch consultant profile and commissions in parallel ─────────────
    //
    // Both queries are independent — running them concurrently halves DB round-trips.
    // Commission query applies a month filter when year_month is provided.

    authedLog.info('Fetching consultant performance', {
      consultant_id: body.consultant_id,
      year_month:    yearMonth,
    })

    // Build the commission query — conditionally date-filtered
    let commissionQuery = admin
      .from('commission_entries')
      .select(COMMISSION_SELECT)
      .eq('consultant_id', body.consultant_id)
      .order('created_at', { ascending: false })

    if (yearMonth !== null) {
      // Parse year and month from YYYY-MM; derive inclusive UTC date range
      const [year, month] = yearMonth.split('-').map(Number)
      const periodStart = new Date(Date.UTC(year, month - 1, 1))
      const periodEnd   = new Date(Date.UTC(year, month, 1))   // exclusive upper bound
      commissionQuery = commissionQuery
        .gte('created_at', periodStart.toISOString())
        .lt('created_at', periodEnd.toISOString())
    }

    const [consultantRes, commissionsRes] = await Promise.all([
      admin
        .from('consultant_profiles')
        .select(CONSULTANT_SELECT)
        .eq('id', body.consultant_id)
        .single(),
      commissionQuery,
    ])

    // ── Step 7: Handle errors ───────────────────────────────────────────────────

    if (consultantRes.error !== null) {
      if (consultantRes.error.code === 'PGRST116') {
        authedLog.warn('Consultant not found', { consultant_id: body.consultant_id })
        return jsonError(req, `Consultant '${body.consultant_id}' not found.`, 404)
      }
      authedLog.error('Consultant query failed', { error: consultantRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (commissionsRes.error !== null) {
      authedLog.error('Commission query failed', { error: commissionsRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 8: Build summary and return ───────────────────────────────────────

    const commissions = (commissionsRes.data ?? []) as CommissionEntry[]
    const summary     = buildSummary(commissions, yearMonth)

    authedLog.info('Performance assembled', {
      consultant_id:   body.consultant_id,
      year_month:      yearMonth,
      total_entries:   summary.total_entries,
      net_earned_cents: summary.net_earned_cents,
    })

    return jsonResponse(req, {
      consultant:  consultantRes.data,
      summary,
      commissions,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
