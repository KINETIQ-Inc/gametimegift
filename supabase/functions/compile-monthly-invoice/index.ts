/**
 * GTG Edge Function — compile-monthly-invoice
 *
 * Complete monthly financial statement compiler for the invoice engine (3E-4).
 * Calls calculate_gross_month and calculate_royalties_month in parallel, then
 * assembles a single unified financial document with a derived summary block.
 * Read-only — no writes. The persist step is a separate downstream operation.
 *
 * ─── Pipeline position ────────────────────────────────────────────────────────
 *
 *   3E-1  aggregate-ledger-by-month   raw per-dimension aggregations
 *   3E-2  calculate-gross             gross/net financial figures
 *   3E-3  calculate-royalties-owed    per-licensor royalty obligations
 *   3E-4  compile-monthly-invoice  ←─ complete financial statement (this function)
 *
 * ─── What this function produces ─────────────────────────────────────────────
 *
 *   summary section (derived):
 *     net_sales_cents                  revenue.net_sales_cents
 *     total_royalties_remittance_cents Σ royalties[].remittance_cents
 *     total_net_commission_cents       commissions.net_commission_cents
 *     approved_payable_cents           commissions.approved_payable_cents
 *     net_platform_cents               net_sales − royalties − net_commission
 *
 *   revenue section:
 *     from calculate_gross_month — gross sales, returns, net, by licensor
 *
 *   commissions section:
 *     from calculate_gross_month — accrued, reversed, net, payable, held,
 *     per-consultant accruals and reversals
 *
 *   royalties section:
 *     from calculate_royalties_month — per-licensor obligation array
 *     (same shape as calculate-royalties-owed response)
 *
 * ─── Parallel execution ───────────────────────────────────────────────────────
 *
 * Both DB functions are called simultaneously via Promise.all. The DB functions
 * are independent read-only queries; parallel execution halves the DB round-trip
 * count for this step.
 *
 * ─── net_platform_cents ───────────────────────────────────────────────────────
 *
 * Approximates the platform's net position before operator expenses:
 *
 *   net_platform_cents = net_sales_cents
 *                        − total_royalties_remittance_cents
 *                        − total_net_commission_cents
 *
 * May be negative. The invoice engine downstream must handle this case — it
 * typically indicates a high-reversal or high-return period.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * This is the master financial document for the period — admin-only access required.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/compile-monthly-invoice
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
 *       "summary": {
 *         "net_sales_cents":                  619856,
 *         "total_royalties_remittance_cents": 88174,
 *         "total_net_commission_cents":       162236,
 *         "approved_payable_cents":           15990,
 *         "net_platform_cents":               369446
 *       },
 *       "revenue": {
 *         "gross_sales_cents": 634823,
 *         "returns_cents":     14967,
 *         "net_sales_cents":   619856,
 *         "by_license_body":  [...]
 *       },
 *       "commissions": {
 *         "gross_accrued_cents":           167470,
 *         "reversals_this_period_cents":   5234,
 *         "net_commission_cents":          162236,
 *         "approved_payable_cents":        15990,
 *         "held_cents":                    24030,
 *         "by_consultant_accrued":         [...],
 *         "by_consultant_reversals":       [...]
 *       },
 *       "royalties": [
 *         {
 *           "license_body":          "ARMY",
 *           "remittance_cents":      22390,
 *           ...
 *         },
 *         {
 *           "license_body":          "CLC",
 *           "remittance_cents":      65784,
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
 *   500  Internal server error (includes which DB function failed)
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

// ── Revenue (from calculate_gross_month) ──────────────────────────────────────

interface ByLicenseBodyRevenue {
  license_body:      string
  gross_sales_cents: number
  returns_cents:     number
  net_sales_cents:   number
}

interface RevenueSection {
  gross_sales_cents: number
  returns_cents:     number
  net_sales_cents:   number
  by_license_body:   ByLicenseBodyRevenue[]
}

// ── Commissions (from calculate_gross_month) ───────────────────────────────────

interface ByConsultantAccrued {
  consultant_id:          string
  entry_count:            number
  gross_accrued_cents:    number
  approved_payable_cents: number
  held_cents:             number
}

interface ByConsultantReversal {
  consultant_id:  string
  reversal_count: number
  reversal_cents: number
}

interface CommissionsSection {
  gross_accrued_cents:         number
  reversals_this_period_cents: number
  net_commission_cents:        number
  approved_payable_cents:      number
  held_cents:                  number
  by_consultant_accrued:       ByConsultantAccrued[]
  by_consultant_reversals:     ByConsultantReversal[]
}

interface GrossResult {
  year_month:   string
  period_start: string
  period_end:   string
  revenue:      RevenueSection
  commissions:  CommissionsSection
}

// ── Royalties (from calculate_royalties_month) ────────────────────────────────

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

// ── Compiled invoice ───────────────────────────────────────────────────────────

interface SummarySection {
  net_sales_cents:                  number
  total_royalties_remittance_cents: number
  total_net_commission_cents:       number
  approved_payable_cents:           number
  net_platform_cents:               number
}

interface MonthlyInvoice {
  year_month:   string
  period_start: string
  period_end:   string
  summary:      SummarySection
  revenue:      RevenueSection
  commissions:  CommissionsSection
  royalties:    RoyaltyEntry[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('compile-monthly-invoice', req)
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

    // ── Step 6: Run DB functions in parallel ────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Compiling monthly invoice', { year_month: body.year_month })

    const [grossRes, royaltiesRes] = await Promise.all([
      admin.rpc('calculate_gross_month',      { p_year_month: body.year_month }),
      admin.rpc('calculate_royalties_month',  { p_year_month: body.year_month }),
    ])

    if (grossRes.error !== null) {
      const gtgMatch = grossRes.error.message.match(/\[GTG\][^.]+\./)
      authedLog.error('calculate_gross_month failed', { error: grossRes.error.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    if (royaltiesRes.error !== null) {
      const gtgMatch = royaltiesRes.error.message.match(/\[GTG\][^.]+\./)
      authedLog.error('calculate_royalties_month failed', { error: royaltiesRes.error.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const gross     = grossRes.data     as GrossResult
    const royalties = royaltiesRes.data as RoyaltiesResult

    // ── Step 7: Derive summary block ────────────────────────────────────────────

    const netSalesCents                = gross.revenue.net_sales_cents
    const totalRoyaltiesRemittanceCents = royalties.royalties.reduce(
      (sum, r) => sum + r.remittance_cents, 0,
    )
    const totalNetCommissionCents      = gross.commissions.net_commission_cents
    const approvedPayableCents         = gross.commissions.approved_payable_cents

    const summary: SummarySection = {
      net_sales_cents:                  netSalesCents,
      total_royalties_remittance_cents: totalRoyaltiesRemittanceCents,
      total_net_commission_cents:       totalNetCommissionCents,
      approved_payable_cents:           approvedPayableCents,
      net_platform_cents:               netSalesCents
                                          - totalRoyaltiesRemittanceCents
                                          - totalNetCommissionCents,
    }

    // ── Step 8: Assemble and return ─────────────────────────────────────────────

    const invoice: MonthlyInvoice = {
      year_month:   gross.year_month,
      period_start: gross.period_start,
      period_end:   gross.period_end,
      summary,
      revenue:      gross.revenue,
      commissions:  gross.commissions,
      royalties:    royalties.royalties,
    }

    authedLog.info('Monthly invoice compiled', {
      year_month:                        body.year_month,
      net_sales_cents:                   summary.net_sales_cents,
      total_royalties_remittance_cents:  summary.total_royalties_remittance_cents,
      total_net_commission_cents:        summary.total_net_commission_cents,
      approved_payable_cents:            summary.approved_payable_cents,
      net_platform_cents:                summary.net_platform_cents,
      licensor_count:                    royalties.royalties.length,
      consultant_count:                  gross.commissions.by_consultant_accrued.length,
    })

    return jsonResponse(req, invoice)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
