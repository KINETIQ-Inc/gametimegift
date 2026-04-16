/**
 * GTG Edge Function — calculate-gross
 *
 * Monthly gross/net financial calculation for the invoice engine (3E-2).
 * Derives actionable financial figures from the ledger and commission tables
 * for a given month. Read-only — no writes.
 *
 * ─── Pipeline position ────────────────────────────────────────────────────────
 *
 *   3E-1  aggregate-ledger-by-month   raw per-dimension aggregations
 *   3E-2  calculate-gross         ←── gross/net financial figures (this function)
 *   3E-3  (invoice generation)        persists the calculated invoice record
 *
 * ─── What this function produces ─────────────────────────────────────────────
 *
 *   revenue section:
 *     gross_sales_cents           All units sold at retail price
 *     returns_cents               All units returned (retail price)
 *     net_sales_cents             gross − returns
 *     by_license_body[]           Per-licensor gross, returns, and net
 *                                 (feeds royalty obligation correlation)
 *
 *   commissions section:
 *     gross_accrued_cents         All commissions created this period
 *     reversals_this_period_cents Commissions reversed (by reversed_at date)
 *     net_commission_cents        gross_accrued − reversals (may be negative)
 *     approved_payable_cents      Status = 'approved' — cleared for payout
 *     held_cents                  Status = 'held' — withheld, not yet payable
 *     by_consultant_accrued[]     Per-consultant accruals with payable/held split
 *     by_consultant_reversals[]   Per-consultant reversals this period
 *
 * ─── Reversal period semantics ────────────────────────────────────────────────
 *
 * Reversals are attributed by reversed_at (when the reversal was processed),
 * not by the original commission's created_at. A March reversal of a January
 * commission is a March deduction. This mirrors accrual accounting and gives
 * the invoice engine an accurate view of the period's net obligation.
 *
 * ─── Negative net commission ─────────────────────────────────────────────────
 *
 * net_commission_cents may be negative in a period with few new sales but
 * many reversals from prior months. The invoice engine downstream must handle
 * this case — it typically indicates clawback obligations or a high-return period.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Gross financial calculations drive payout decisions.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/calculate-gross
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "year_month": "2026-03" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "year_month":   "2026-03",
 *       "period_start": "2026-03-01",
 *       "period_end":   "2026-03-31",
 *       "revenue": {
 *         "gross_sales_cents": 634823,
 *         "returns_cents":     14967,
 *         "net_sales_cents":   619856,
 *         "by_license_body": [
 *           {
 *             "license_body":      "CLC",
 *             "gross_sales_cents": 469882,
 *             "returns_cents":     9980,
 *             "net_sales_cents":   459902
 *           },
 *           {
 *             "license_body":      "ARMY",
 *             "gross_sales_cents": 164941,
 *             "returns_cents":     4987,
 *             "net_sales_cents":   159954
 *           }
 *         ]
 *       },
 *       "commissions": {
 *         "gross_accrued_cents":           167470,
 *         "reversals_this_period_cents":   5234,
 *         "net_commission_cents":          162236,
 *         "approved_payable_cents":        15990,
 *         "held_cents":                    24030,
 *         "by_consultant_accrued": [
 *           {
 *             "consultant_id":          "<uuid>",
 *             "entry_count":            18,
 *             "gross_accrued_cents":    13486,
 *             "approved_payable_cents": 0,
 *             "held_cents":             0
 *           }
 *         ],
 *         "by_consultant_reversals": [
 *           {
 *             "consultant_id":  "<uuid>",
 *             "reversal_count": 1,
 *             "reversal_cents": 1498
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing year_month, invalid format)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

// YYYY-MM: four-digit year, hyphen, two-digit month 01–12
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  year_month: string
}

interface ByLicenseBody {
  license_body:      string
  gross_sales_cents: number
  returns_cents:     number
  net_sales_cents:   number
}

interface ByConsultantAccrued {
  consultant_id:          string
  entry_count:            number
  gross_accrued_cents:    number
  approved_payable_cents: number
  held_cents:             number
}

interface ByConsultantReversal {
  consultant_id: string
  reversal_count: number
  reversal_cents: number
}

interface RevenueSection {
  gross_sales_cents: number
  returns_cents:     number
  net_sales_cents:   number
  by_license_body:   ByLicenseBody[]
}

interface CommissionsSection {
  gross_accrued_cents:           number
  reversals_this_period_cents:   number
  net_commission_cents:          number
  approved_payable_cents:        number
  held_cents:                    number
  by_consultant_accrued:         ByConsultantAccrued[]
  by_consultant_reversals:       ByConsultantReversal[]
}

interface GrossResult {
  year_month:   string
  period_start: string
  period_end:   string
  revenue:      RevenueSection
  commissions:  CommissionsSection
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('calculate-gross', req)
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

    if (!body.year_month || !YEAR_MONTH_RE.test(body.year_month)) {
      return jsonError(
        req,
        "year_month must be a valid month in YYYY-MM format (e.g. '2026-03'). " +
        'Month must be 01–12.',
        400,
      )
    }

    // ── Step 6: Calculate gross ─────────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Calculating gross for month', { year_month: body.year_month })

    const { data: result, error: rpcError } = await admin.rpc(
      'calculate_gross_month',
      { p_year_month: body.year_month },
    )

    if (rpcError !== null) {
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('calculate_gross_month failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const gross = result as GrossResult

    authedLog.info('Gross calculation complete', {
      year_month:                    body.year_month,
      gross_sales_cents:             gross.revenue.gross_sales_cents,
      net_sales_cents:               gross.revenue.net_sales_cents,
      returns_cents:                 gross.revenue.returns_cents,
      gross_accrued_cents:           gross.commissions.gross_accrued_cents,
      net_commission_cents:          gross.commissions.net_commission_cents,
      reversals_this_period_cents:   gross.commissions.reversals_this_period_cents,
      approved_payable_cents:        gross.commissions.approved_payable_cents,
      consultant_count:              gross.commissions.by_consultant_accrued.length,
    })

    return jsonResponse(req, gross)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
