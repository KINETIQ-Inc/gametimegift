/**
 * GTG Edge Function — calculate-royalties-owed
 *
 * Per-licensor monthly royalty obligation calculation for the invoice engine (3E-3).
 * Calls the calculate_royalties_month DB function which runs CLC and ARMY in a
 * single query. Read-only — no writes.
 *
 * ─── Pipeline position ────────────────────────────────────────────────────────
 *
 *   3E-1  aggregate-ledger-by-month   raw per-dimension aggregations
 *   3E-2  calculate-gross             gross/net financial figures
 *   3E-3  calculate-royalties-owed ←─ per-licensor royalty obligations (this function)
 *   3E-4  compile-monthly-invoice     complete financial statement
 *
 * ─── Royalty math ─────────────────────────────────────────────────────────────
 *
 * Matches calculate-royalty (3C-2) exactly:
 *
 *   per unit:    unit_royalty_cents = ROUND(retail_price_cents × royalty_rate)
 *   period total: royalty_cents = Σ unit_royalty_cents
 *   floor:       remittance_cents = GREATEST(royalty_cents, minimum_royalty_cents ?? 0)
 *
 * ─── Response fields ──────────────────────────────────────────────────────────
 *
 * Each licensor entry includes:
 *   license_body           — 'CLC' | 'ARMY'
 *   license_holder_id      — UUID of active license_holders row
 *   license_holder_name    — legal name for display/invoicing
 *   license_holder_code    — short code (e.g. 'CLC-001')
 *   reporting_period       — 'monthly' | 'quarterly'
 *   default_royalty_rate   — current rate (informational; stamped rates used for calc)
 *   minimum_royalty_cents  — contract floor; null = no floor
 *   units_sold             — units sold in the period attributable to this licensor
 *   gross_sales_cents      — sum of retail_price_cents for sold units
 *   royalty_cents          — Σ ROUND(retail_price_cents × royalty_rate) per unit
 *   remittance_cents       — GREATEST(royalty_cents, minimum_royalty_cents ?? 0)
 *   minimum_applied        — true when minimum floor exceeded the calculated royalty
 *   has_rate_mismatch      — true when any unit's stamped rate differs from current
 *   rate_groups            — breakdown by stamped rate (audit trail)
 *   ledger_entry_ids       — all ledger entry UUIDs feeding this calculation
 *   existing_entry_id      — UUID if a royalty_entries row already exists for period
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Royalty obligations drive licensor payables — admin-only access required.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/calculate-royalties-owed
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
 *       "royalties": [
 *         {
 *           "license_body":          "CLC",
 *           "license_holder_id":     "<uuid>",
 *           "license_holder_name":   "Collegiate Licensing Company",
 *           "license_holder_code":   "CLC-001",
 *           "reporting_period":      "monthly",
 *           "default_royalty_rate":  0.14,
 *           "minimum_royalty_cents": 50000,
 *           "units_sold":            94,
 *           "gross_sales_cents":     469882,
 *           "royalty_cents":         65784,
 *           "remittance_cents":      65784,
 *           "minimum_applied":       false,
 *           "has_rate_mismatch":     false,
 *           "rate_groups": [
 *             {
 *               "royalty_rate":      0.14,
 *               "unit_count":        94,
 *               "gross_sales_cents": 469882,
 *               "royalty_cents":     65784
 *             }
 *           ],
 *           "ledger_entry_ids": ["<uuid>", ...],
 *           "existing_entry_id": null
 *         },
 *         {
 *           "license_body":          "ARMY",
 *           ...
 *         }
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

// YYYY-MM: four-digit year, hyphen, two-digit month 01–12
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  year_month: string
}

interface RateGroup {
  royalty_rate:      number
  unit_count:        number
  gross_sales_cents: number
  royalty_cents:     number
}

interface RoyaltyEntry {
  license_body:          string
  license_holder_id:     string
  license_holder_name:   string
  license_holder_code:   string
  reporting_period:      string
  default_royalty_rate:  number
  minimum_royalty_cents: number | null
  units_sold:            number
  gross_sales_cents:     number
  royalty_cents:         number
  remittance_cents:      number
  minimum_applied:       boolean
  has_rate_mismatch:     boolean
  rate_groups:           RateGroup[]
  ledger_entry_ids:      string[]
  existing_entry_id:     string | null
}

interface RoyaltiesResult {
  year_month:   string
  period_start: string
  period_end:   string
  royalties:    RoyaltyEntry[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('calculate-royalties-owed', req)
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

    // ── Step 6: Calculate royalties owed ────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Calculating royalties owed for month', { year_month: body.year_month })

    const { data: result, error: rpcError } = await admin.rpc(
      'calculate_royalties_month',
      { p_year_month: body.year_month },
    )

    if (rpcError !== null) {
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('calculate_royalties_month failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const royalties = result as RoyaltiesResult

    authedLog.info('Royalties calculation complete', {
      year_month:                body.year_month,
      licensor_count:            royalties.royalties.length,
      total_remittance_cents:    royalties.royalties.reduce((s, r) => s + r.remittance_cents, 0),
      total_units_sold:          royalties.royalties.reduce((s, r) => s + r.units_sold, 0),
      minimum_applied_count:     royalties.royalties.filter((r) => r.minimum_applied).length,
      rate_mismatch_count:       royalties.royalties.filter((r) => r.has_rate_mismatch).length,
      existing_entry_count:      royalties.royalties.filter((r) => r.existing_entry_id !== null).length,
    })

    return jsonResponse(req, royalties)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
