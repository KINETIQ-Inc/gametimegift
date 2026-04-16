/**
 * GTG Edge Function — calculate-royalty
 *
 * Computes the royalty obligation for one license body over a reporting period.
 * This is a read-only calculation — it writes nothing to the database.
 * Use the output to drive the royalty entry creation step (3C-3).
 *
 * ─── What this function does ──────────────────────────────────────────────────
 *
 * 1. Resolves the active license_holder for the given license_body (CLC or ARMY).
 *
 * 2. Checks whether a royalty_entry already exists for this
 *    (license_holder_id, period_start, period_end) combination, and surfaces
 *    its ID if so. The unique constraint on royalty_entries means 3C-3 cannot
 *    insert a duplicate — the caller should review the existing entry before
 *    proceeding.
 *
 * 3. Fetches every inventory_ledger_entries row with action='sold' for this
 *    license_body whose occurred_at falls within the period (inclusive).
 *    Returns early with units_sold=0 if no sales exist.
 *
 * 4. Computes per-unit royalty:
 *      unit_royalty_cents = Math.round(retail_price_cents × unit.royalty_rate)
 *    Each unit carries its royalty_rate stamped at receive time. Units received
 *    under older rate agreements retain their historical rate; the calculation
 *    honours those rates rather than applying the current rate retroactively.
 *
 * 5. Groups results by royalty_rate for audit visibility. Most periods will
 *    have a single rate group (all units received under the same agreement).
 *    Multiple groups indicate rate changes mid-period and are flagged with
 *    has_rate_mismatch = true.
 *
 * 6. Totals: units_sold, gross_sales_cents, royalty_cents.
 *
 * 7. Applies the minimum royalty floor:
 *      remittance_cents = max(royalty_cents, minimum_royalty_cents ?? 0)
 *      minimum_applied  = remittance_cents > royalty_cents
 *
 * 8. Derives royalty_rate for the royalty_entries row:
 *    - Single rate group → that rate
 *    - Multiple rate groups → weighted effective rate:
 *        effective_rate = royalty_cents / gross_sales_cents
 *      Stored as the representative rate for the period record. The full
 *      breakdown is in rate_groups; ledger_entry_ids is the authoritative
 *      audit chain regardless.
 *
 * ─── Royalty math ─────────────────────────────────────────────────────────────
 *
 *   Per unit:
 *     unit_royalty_cents = Math.round(retail_price_cents × royalty_rate)
 *
 *   Period total:
 *     royalty_cents = Σ unit_royalty_cents       (integer sum of rounded units)
 *     remittance_cents = max(royalty_cents, minimum_royalty_cents ?? 0)
 *
 *   Stored rate (for royalty_entries.royalty_rate):
 *     single-rate period  → that rate
 *     multi-rate period   → royalty_cents / gross_sales_cents (4-decimal precision)
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * REPORTING_ROLES: super_admin, admin, licensor_auditor.
 * Royalty calculations involve confidential sales data and license agreement terms.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/calculate-royalty
 *   Authorization: Bearer <reporting-jwt>
 *   Content-Type: application/json
 *   {
 *     "license_body":  "CLC",           // required; CLC or ARMY
 *     "period_start":  "2026-01-01",    // required; ISO 8601 date (YYYY-MM-DD)
 *     "period_end":    "2026-03-31"     // required; ISO 8601 date (YYYY-MM-DD)
 *   }
 *
 * ─── Response: sales found ───────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "license_body": "CLC",
 *       "period_start": "2026-01-01",
 *       "period_end":   "2026-03-31",
 *       "license_holder": {
 *         "id": "...",
 *         "legal_name": "Collegiate Licensing Company",
 *         "code": "CLC",
 *         "default_royalty_rate": 0.145,
 *         "minimum_royalty_cents": 25000,
 *         "reporting_period": "quarterly"
 *       },
 *       "existing_entry_id": null,
 *       "units_sold": 42,
 *       "gross_sales_cents": 209958,
 *       "royalty_rate": 0.145,
 *       "royalty_cents": 30444,
 *       "minimum_royalty_cents": 25000,
 *       "minimum_applied": false,
 *       "remittance_cents": 30444,
 *       "has_rate_mismatch": false,
 *       "rate_groups": [
 *         {
 *           "royalty_rate": 0.145,
 *           "unit_count": 42,
 *           "gross_sales_cents": 209958,
 *           "royalty_cents": 30444
 *         }
 *       ],
 *       "ledger_entry_ids": ["uuid", "uuid", ...]
 *     }
 *   }
 *
 * ─── Response: no sales in period ────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       ...
 *       "units_sold": 0,
 *       "gross_sales_cents": 0,
 *       "royalty_rate": 0.145,
 *       "royalty_cents": 0,
 *       "minimum_applied": true,
 *       "remittance_cents": 25000,
 *       "rate_groups": [],
 *       "ledger_entry_ids": []
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (invalid fields, period_end before period_start)
 *   401  Unauthenticated
 *   403  Forbidden
 *   404  No active license_holder for the given body
 *   500  Internal server error
 */

import { REPORTING_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_ROYALTY_BODIES = new Set(['CLC', 'ARMY'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  license_body: string
  period_start: string
  period_end:   string
}

interface RateGroup {
  royalty_rate:       number
  unit_count:         number
  gross_sales_cents:  number
  royalty_cents:      number
}

interface LicenseHolderSummary {
  id:                    string
  legal_name:            string
  code:                  string
  default_royalty_rate:  number
  minimum_royalty_cents: number | null
  reporting_period:      string
}

interface ResponsePayload {
  license_body:          string
  period_start:          string
  period_end:            string
  license_holder:        LicenseHolderSummary
  /** ID of an existing royalty_entry for this period, or null if none exists. */
  existing_entry_id:     string | null
  units_sold:            number
  gross_sales_cents:     number
  /**
   * Rate stored in royalty_entries.royalty_rate:
   *   - Single rate group → that rate
   *   - Multiple rate groups → effective rate = royalty_cents / gross_sales_cents
   *   - Zero sales → license holder's current default_royalty_rate
   */
  royalty_rate:          number
  royalty_cents:         number
  /** From license_holder.minimum_royalty_cents — null if no floor. */
  minimum_royalty_cents: number | null
  minimum_applied:       boolean
  /** max(royalty_cents, minimum_royalty_cents ?? 0) */
  remittance_cents:      number
  /** True when any unit carries a royalty_rate != license_holder.default_royalty_rate. */
  has_rate_mismatch:     boolean
  rate_groups:           RateGroup[]
  /** inventory_ledger_entries.id values for royalty_entries.ledger_entry_ids. */
  ledger_entry_ids:      string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Round a royalty amount to the nearest cent.
 * Matches the per-unit rounding used in commission calculation.
 */
function roundCents(amount: number): number {
  return Math.round(amount)
}

/**
 * Compute the effective rate for a multi-rate period.
 * Returns 4-decimal precision to match the numeric(5,4) column.
 * Guards against division by zero (zero gross sales case).
 */
function effectiveRate(royaltyCents: number, grossSalesCents: number): number {
  if (grossSalesCents === 0) return 0
  return Math.round((royaltyCents / grossSalesCents) * 10000) / 10000
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('calculate-royalty', req)
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

    const { authorized, denied } = verifyRole(user, REPORTING_ROLES, req)
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

    if (!body.license_body || !VALID_ROYALTY_BODIES.has(body.license_body)) {
      return jsonError(
        req,
        `license_body must be one of: ${[...VALID_ROYALTY_BODIES].join(', ')} ` +
        `('NONE' units carry no royalty obligation and are excluded from calculations)`,
        400,
      )
    }

    if (!body.period_start || !ISO_DATE.test(body.period_start)) {
      return jsonError(req, 'period_start must be an ISO 8601 date (YYYY-MM-DD)', 400)
    }
    if (!body.period_end || !ISO_DATE.test(body.period_end)) {
      return jsonError(req, 'period_end must be an ISO 8601 date (YYYY-MM-DD)', 400)
    }
    if (body.period_start > body.period_end) {
      return jsonError(req, 'period_start must be on or before period_end', 400)
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch license holder and check for existing entry (parallel) ──

    const [holderResult, existingResult] = await Promise.all([
      admin
        .from('license_holders')
        .select(`
          id, legal_name, code,
          default_royalty_rate, minimum_royalty_cents, reporting_period
        `)
        .eq('license_body', body.license_body)
        .eq('is_active', true)
        .order('rate_effective_date', { ascending: false })
        .limit(1)
        .single(),

      admin
        .from('royalty_entries')
        .select('id')
        .eq('license_body', body.license_body)
        .eq('period_start', body.period_start)
        .eq('period_end', body.period_end)
        .limit(1)
        .single(),
    ])

    if (holderResult.error !== null) {
      if (holderResult.error.code === 'PGRST116') {
        return jsonError(
          req,
          `No active license_holder found for license_body '${body.license_body}'. ` +
          `An admin must create an active record before royalties can be calculated.`,
          404,
        )
      }
      authedLog.error('DB error fetching license holder', { code: holderResult.error.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const holder = holderResult.data
    // existingResult error code PGRST116 = no row = no existing entry (expected).
    const existingEntryId = (existingResult.error === null && existingResult.data)
      ? existingResult.data.id
      : null

    if (existingEntryId !== null) {
      authedLog.info('Existing royalty entry found', {
        existing_entry_id: existingEntryId,
        period_start: body.period_start,
        period_end:   body.period_end,
      })
    }

    // ── Step 7: Fetch sold ledger entries for this body and period ────────────
    // Uses the index: inventory_ledger_entries_sold_license_idx
    // (license_body, occurred_at DESC) WHERE action = 'sold'
    //
    // Period boundaries are inclusive on both ends:
    //   occurred_at >= period_start 00:00:00 UTC
    //   occurred_at <= period_end   23:59:59.999 UTC

    const { data: ledgerRows, error: ledgerError } = await admin
      .from('inventory_ledger_entries')
      .select('id, retail_price_cents, royalty_rate')
      .eq('license_body', body.license_body)
      .eq('action', 'sold')
      .gte('occurred_at', `${body.period_start}T00:00:00.000Z`)
      .lte('occurred_at', `${body.period_end}T23:59:59.999Z`)
      .order('occurred_at', { ascending: true })

    if (ledgerError !== null) {
      authedLog.error('DB error fetching ledger entries', { code: ledgerError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const rows = ledgerRows ?? []

    authedLog.info('Ledger entries fetched', {
      license_body: body.license_body,
      period_start: body.period_start,
      period_end:   body.period_end,
      row_count:    rows.length,
    })

    // ── Step 8: Aggregate per-unit royalties, grouped by rate ─────────────────

    const rateMap = new Map<number, RateGroup>()
    const ledgerEntryIds: string[] = []
    let totalGrossSalesCents = 0
    let totalRoyaltyCents    = 0
    const currentDefaultRate = Number(holder.default_royalty_rate)

    for (const row of rows) {
      const retailCents  = row.retail_price_cents as number
      const unitRate     = Number(row.royalty_rate)
      const unitRoyalty  = roundCents(retailCents * unitRate)

      ledgerEntryIds.push(row.id as string)
      totalGrossSalesCents += retailCents
      totalRoyaltyCents    += unitRoyalty

      const existing = rateMap.get(unitRate)
      if (existing !== undefined) {
        existing.unit_count         += 1
        existing.gross_sales_cents  += retailCents
        existing.royalty_cents      += unitRoyalty
      } else {
        rateMap.set(unitRate, {
          royalty_rate:      unitRate,
          unit_count:        1,
          gross_sales_cents: retailCents,
          royalty_cents:     unitRoyalty,
        })
      }
    }

    const rateGroups = [...rateMap.values()].sort(
      (a, b) => b.unit_count - a.unit_count,  // most common rate first
    )

    // ── Step 9: Determine the stored royalty_rate ──────────────────────────────

    let storedRoyaltyRate: number

    if (rateGroups.length === 0) {
      // No sales — use the license holder's current rate as the period rate.
      storedRoyaltyRate = currentDefaultRate
    } else if (rateGroups.length === 1) {
      // All units share one rate — use it directly.
      storedRoyaltyRate = rateGroups[0]!.royalty_rate
    } else {
      // Multiple rates — compute weighted effective rate.
      storedRoyaltyRate = effectiveRate(totalRoyaltyCents, totalGrossSalesCents)
    }

    const hasRateMismatch = rateGroups.some(
      (g) => g.royalty_rate !== currentDefaultRate,
    )

    if (hasRateMismatch) {
      authedLog.info('Rate mismatch detected in period', {
        license_body:    body.license_body,
        current_rate:    currentDefaultRate,
        rates_found:     rateGroups.map((g) => g.royalty_rate),
      })
    }

    // ── Step 10: Apply minimum royalty floor ──────────────────────────────────

    const minimumRoyaltyCents = holder.minimum_royalty_cents as number | null
    const minimumApplied =
      minimumRoyaltyCents !== null && minimumRoyaltyCents > totalRoyaltyCents
    const remittanceCents = minimumApplied
      ? minimumRoyaltyCents!
      : totalRoyaltyCents

    // ── Step 11: Build and return response ────────────────────────────────────

    authedLog.info('Royalty calculation complete', {
      license_body:      body.license_body,
      units_sold:        rows.length,
      gross_sales_cents: totalGrossSalesCents,
      royalty_cents:     totalRoyaltyCents,
      remittance_cents:  remittanceCents,
      minimum_applied:   minimumApplied,
      has_rate_mismatch: hasRateMismatch,
      rate_group_count:  rateGroups.length,
    })

    const payload: ResponsePayload = {
      license_body:          body.license_body,
      period_start:          body.period_start,
      period_end:            body.period_end,
      license_holder: {
        id:                    holder.id,
        legal_name:            holder.legal_name,
        code:                  holder.code,
        default_royalty_rate:  currentDefaultRate,
        minimum_royalty_cents: minimumRoyaltyCents,
        reporting_period:      holder.reporting_period,
      },
      existing_entry_id:     existingEntryId,
      units_sold:            rows.length,
      gross_sales_cents:     totalGrossSalesCents,
      royalty_rate:          storedRoyaltyRate,
      royalty_cents:         totalRoyaltyCents,
      minimum_royalty_cents: minimumRoyaltyCents,
      minimum_applied:       minimumApplied,
      remittance_cents:      remittanceCents,
      has_rate_mismatch:     hasRateMismatch,
      rate_groups:           rateGroups,
      ledger_entry_ids:      ledgerEntryIds,
    }

    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
