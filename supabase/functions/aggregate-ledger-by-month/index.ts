/**
 * GTG Edge Function — aggregate-ledger-by-month
 *
 * Read-only monthly ledger aggregation. Produces the structured summary that
 * feeds the monthly invoice generation pipeline (3E-2+). Does not write to
 * the database.
 *
 * ─── Data sources ─────────────────────────────────────────────────────────────
 *
 *   inventory_ledger_entries   action = 'sold'      → per-unit revenue
 *                              action = 'returned'  → returns (commission risk)
 *   commission_entries         all statuses          → authoritative commission amounts
 *
 * ─── Response structure ───────────────────────────────────────────────────────
 *
 *   sales_totals       — gross units sold and revenue for the month
 *   by_license_body    — revenue breakdown per licensor (for royalty correlation)
 *   by_consultant      — per-consultant sales and stamped commission amounts
 *   direct_sales       — storefront/admin sales with no consultant attribution
 *   returns            — return volume and retail value; commissions at risk
 *   commissions        — commission entry counts and amounts by lifecycle status
 *
 * ─── Commission amounts ───────────────────────────────────────────────────────
 *
 * by_consultant.total_commission_cents comes from commission_entries.commission_cents
 * (stamped at sale time) via a LEFT JOIN — not from re-computing
 * retail_price_cents × commission_rate. This preserves historical accuracy
 * when a consultant's tier has changed since the sale.
 *
 * ─── Period boundaries ───────────────────────────────────────────────────────
 *
 * Ledger events: bounded by occurred_at (UTC, server-generated at insert).
 * Commission entries: bounded by created_at (inserted at sale time — reliable
 * proxy for commission earn date).
 *
 * Both use the same UTC boundaries:
 *   period_start = first day of month 00:00:00 UTC (inclusive)
 *   period_end   = first day of next month 00:00:00 UTC (exclusive)
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Monthly aggregation includes financial data and consultant commission detail
 * that drives payout decisions — admin-only access is required.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/aggregate-ledger-by-month
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
 *       "sales_totals": {
 *         "units_sold":        127,
 *         "gross_sales_cents": 634823
 *       },
 *       "by_license_body": [
 *         { "license_body": "CLC",  "units_sold": 94,  "gross_sales_cents": 469882 },
 *         { "license_body": "ARMY", "units_sold": 33,  "gross_sales_cents": 164941 }
 *       ],
 *       "by_consultant": [
 *         {
 *           "consultant_id":          "<uuid>",
 *           "units_sold":             18,
 *           "gross_sales_cents":      89910,
 *           "commission_entry_count": 18,
 *           "total_commission_cents": 13486
 *         }
 *       ],
 *       "direct_sales": {
 *         "units_sold":        12,
 *         "gross_sales_cents": 59892
 *       },
 *       "returns": {
 *         "units_returned":        3,
 *         "returned_retail_cents": 14967,
 *         "consultant_attributed": 2
 *       },
 *       "commissions": [
 *         { "status": "earned",   "entry_count": 97,  "total_commission_cents": 127450 },
 *         { "status": "held",     "entry_count": 18,  "total_commission_cents": 24030 },
 *         { "status": "approved", "entry_count": 12,  "total_commission_cents": 15990 }
 *       ]
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

// YYYY-MM format: four-digit year, hyphen, two-digit month
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  year_month: string
}

interface SalesTotals {
  units_sold:        number
  gross_sales_cents: number
}

interface ByLicenseBody {
  license_body:      string
  units_sold:        number
  gross_sales_cents: number
}

interface ByConsultant {
  consultant_id:          string
  units_sold:             number
  gross_sales_cents:      number
  commission_entry_count: number
  total_commission_cents: number
}

interface Returns {
  units_returned:        number
  returned_retail_cents: number
  consultant_attributed: number
}

interface CommissionByStatus {
  status:                 string
  entry_count:            number
  total_commission_cents: number
}

interface AggregateResult {
  year_month:       string
  period_start:     string
  period_end:       string
  sales_totals:     SalesTotals
  by_license_body:  ByLicenseBody[]
  by_consultant:    ByConsultant[]
  direct_sales:     SalesTotals
  returns:          Returns
  commissions:      CommissionByStatus[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('aggregate-ledger-by-month', req)
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

    // ── Step 6: Run aggregation ─────────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Running monthly ledger aggregation', { year_month: body.year_month })

    const { data: result, error: rpcError } = await admin.rpc(
      'aggregate_ledger_month',
      { p_year_month: body.year_month },
    )

    if (rpcError !== null) {
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('aggregate_ledger_month failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const aggregate = result as AggregateResult

    authedLog.info('Aggregation complete', {
      year_month:          body.year_month,
      units_sold:          aggregate.sales_totals.units_sold,
      gross_sales_cents:   aggregate.sales_totals.gross_sales_cents,
      consultant_count:    aggregate.by_consultant.length,
      units_returned:      aggregate.returns.units_returned,
      commission_statuses: aggregate.commissions.map((c) => c.status),
    })

    return jsonResponse(req, aggregate)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
