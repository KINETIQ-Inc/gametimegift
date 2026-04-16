/**
 * GTG Edge Function — generate-clc-report
 *
 * CLC (Collegiate Licensing Company) royalty compliance report (4D-1).
 * Read-only — no writes. Assembles the complete report package for a
 * reporting period: licensor details, royalty obligation, unit-level sale
 * audit trail, and any active CLC-authority enforcement locks.
 *
 * ─── Report structure ─────────────────────────────────────────────────────────
 *
 *   licensor      Active CLC license_holders record — contact, rate agreement,
 *                 reporting cadence, minimum floor.
 *
 *   royalty_entry The authoritative royalty_entries row for the period.
 *                 Created by the calculate-royalties / generate-invoice-record
 *                 pipeline. Includes remittance amount, minimum-applied flag,
 *                 and current submission status (calculated → submitted → paid).
 *
 *   unit_sales    Per-unit breakdown expanded from royalty_entry.ledger_entry_ids.
 *                 Each row shows the individual sale event: serial number, SKU,
 *                 retail price, royalty rate stamped at sale, and computed
 *                 royalty cents. Provides the traversable audit chain from total
 *                 remittance back to individual transactions.
 *
 *   active_locks  CLC-authority enforcement locks currently in force (is_active = true).
 *                 These are lock_records where lock_authority = 'clc' — units that
 *                 CLC has directed GTG to hold, which must be disclosed in the report.
 *
 * ─── Period lookup ────────────────────────────────────────────────────────────
 *
 * Accepts year_month (YYYY-MM). The royalty_entry is located by finding the
 * CLC entry whose period_start ≤ first-day-of-month ≤ period_end. This means
 * any month within a quarterly period returns the same quarterly report, and
 * any month within a monthly period returns that month's report — the endpoint
 * is agnostic to the reporting cadence stored on the entry.
 *
 * If no royalty_entry exists for the CLC licensor covering the given month,
 * a 404 is returned. Run calculate-royalties-owed (3E-3) and
 * generate-invoice-record (3E-4) first to produce the royalty entry.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * The report includes financial obligation data and enforcement lock detail.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/generate-clc-report
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "year_month": "2026-01" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "report": {
 *         "generated_at":    "2026-03-06T...",
 *         "license_body":    "CLC",
 *         "period_start":    "2026-01-01",
 *         "period_end":      "2026-03-31",
 *         "reporting_period": "quarterly"
 *       },
 *       "licensor": {
 *         "id":                    "<uuid>",
 *         "legal_name":            "Collegiate Licensing Company",
 *         "code":                  "CLC",
 *         "contact_name":          "...",
 *         "contact_email":         "...",
 *         "default_royalty_rate":  0.145,
 *         "minimum_royalty_cents": 50000,
 *         "reporting_period":      "quarterly",
 *         "rate_effective_date":   "2026-01-01",
 *         "rate_expiry_date":      null
 *       },
 *       "royalty_entry": {
 *         "id":                        "<uuid>",
 *         "units_sold":                47,
 *         "gross_sales_cents":         234953,
 *         "royalty_rate":              0.145,
 *         "royalty_cents":             34068,
 *         "remittance_cents":          50000,
 *         "minimum_applied":           true,
 *         "status":                    "calculated",
 *         "licensor_reference_id":     null,
 *         "submitted_at":              null,
 *         "submitted_by":              null,
 *         "paid_at":                   null,
 *         "payment_reference":         null,
 *         "dispute_note":              null,
 *         "resolution_note":           null,
 *         "adjusted_remittance_cents": null,
 *         "created_at":                "2026-03-06T...",
 *         "updated_at":                "2026-03-06T..."
 *       },
 *       "unit_sales": [
 *         {
 *           "ledger_entry_id":   "<uuid>",
 *           "unit_id":           "<uuid>",
 *           "serial_number":     "GTG-CLC-2026-0001",
 *           "sku":               "APP-NIKE-JERSEY-M",
 *           "product_name":      "Nike Jersey — Medium",
 *           "retail_price_cents": 4999,
 *           "royalty_rate":      0.145,
 *           "royalty_cents":     724,
 *           "occurred_at":       "2026-02-15T..."
 *         }
 *       ],
 *       "active_locks": [
 *         {
 *           "id":                    "<uuid>",
 *           "scope":                 "unit",
 *           "target_id":             "<uuid>",
 *           "target_label":          "GTG-CLC-2026-0042",
 *           "lock_reason":           "CLC audit hold — suspected counterfeit.",
 *           "licensor_reference_id": "CLC-REF-001",
 *           "locked_at":             "2026-02-20T..."
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
 *   404  No CLC royalty entry found for the given period, or no active CLC licensor
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  year_month?: string
}

interface RoyaltyEntry {
  id:                        string
  license_holder_id:         string
  license_body:              string
  license_holder_name:       string
  reporting_period:          string
  period_start:              string
  period_end:                string
  ledger_entry_ids:          string[]
  units_sold:                number
  gross_sales_cents:         number
  royalty_rate:              number
  royalty_cents:             number
  remittance_cents:          number
  minimum_applied:           boolean
  status:                    string
  licensor_reference_id:     string | null
  submitted_at:              string | null
  submitted_by:              string | null
  paid_at:                   string | null
  payment_reference:         string | null
  dispute_note:              string | null
  resolution_note:           string | null
  adjusted_remittance_cents: number | null
  created_at:                string
  updated_at:                string
}

interface LedgerEntry {
  id:                 string
  unit_id:            string
  serial_number:      string
  sku:                string
  product_name:       string
  retail_price_cents: number | null
  royalty_rate:       number
  occurred_at:        string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('generate-clc-report', req)
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

    if (!body.year_month || typeof body.year_month !== 'string' ||
        !YEAR_MONTH_RE.test(body.year_month)) {
      return jsonError(
        req,
        "year_month is required and must be in YYYY-MM format (e.g. '2026-01').",
        400,
      )
    }

    const yearMonth = body.year_month

    // Derive first day of the given month to use as the period probe point
    const [year, month] = yearMonth.split('-').map(Number)
    const probeDate = `${year}-${String(month).padStart(2, '0')}-01`

    const admin = createAdminClient()

    // ── Step 6: Fetch CLC royalty entry for the period ──────────────────────────
    //
    // Find the royalty_entry whose period contains the given month.
    // A quarterly entry (period_start = Jan, period_end = Mar) is found by any
    // month in Q1. A monthly entry is found only by its own month.

    authedLog.info('Fetching CLC royalty entry', { year_month: yearMonth, probe_date: probeDate })

    const { data: royaltyEntry, error: royaltyError } = await admin
      .from('royalty_entries')
      .select('*')
      .eq('license_body', 'CLC')
      .lte('period_start', probeDate)
      .gte('period_end', probeDate)
      .neq('status', 'voided')
      .order('period_start', { ascending: false })
      .limit(1)
      .single()

    if (royaltyError !== null) {
      if (royaltyError.code === 'PGRST116') {
        authedLog.warn('No CLC royalty entry found', { year_month: yearMonth })
        return jsonError(
          req,
          `No CLC royalty entry found for a period containing ${yearMonth}. ` +
          'Run calculate-royalties-owed (3E-3) and generate-invoice-record (3E-4) ' +
          'to produce the royalty entry before generating this report.',
          404,
        )
      }
      authedLog.error('Royalty entry query failed', { error: royaltyError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const entry = royaltyEntry as RoyaltyEntry

    authedLog.info('CLC royalty entry found', {
      royalty_entry_id: entry.id,
      period_start:     entry.period_start,
      period_end:       entry.period_end,
      units_sold:       entry.units_sold,
      status:           entry.status,
    })

    // ── Step 7: Parallel fetch — licensor + ledger detail + active locks ─────────
    //
    // All three are independent of each other; run concurrently.

    const ledgerIds: string[] = entry.ledger_entry_ids ?? []

    const [licensorRes, ledgerRes, locksRes] = await Promise.all([

      // Active CLC license_holders record
      admin
        .from('license_holders')
        .select(
          'id, legal_name, code, contact_name, contact_email, ' +
          'default_royalty_rate, minimum_royalty_cents, reporting_period, ' +
          'rate_effective_date, rate_expiry_date',
        )
        .eq('license_body', 'CLC')
        .eq('is_active', true)
        .order('rate_effective_date', { ascending: false })
        .limit(1)
        .single(),

      // Unit-level sale detail — expanded from ledger_entry_ids
      // Skip if no entries (shouldn't happen given units_sold > 0 constraint, but safe)
      ledgerIds.length > 0
        ? admin
            .from('inventory_ledger_entries')
            .select(
              'id, unit_id, serial_number, sku, product_name, ' +
              'retail_price_cents, royalty_rate, occurred_at',
            )
            .in('id', ledgerIds)
            .order('occurred_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),

      // Active CLC-authority enforcement locks — must be disclosed in report
      admin
        .from('lock_records')
        .select(
          'id, scope, target_id, target_label, ' +
          'lock_reason, licensor_reference_id, locked_at',
        )
        .eq('lock_authority', 'clc')
        .eq('is_active', true)
        .order('locked_at', { ascending: true }),
    ])

    // ── Step 8: Handle query errors ─────────────────────────────────────────────

    if (licensorRes.error !== null) {
      if (licensorRes.error.code === 'PGRST116') {
        authedLog.warn('No active CLC licensor record found')
        return jsonError(
          req,
          'No active CLC license_holders record found. ' +
          'An active CLC licensor record is required to generate this report.',
          404,
        )
      }
      authedLog.error('Licensor query failed', { error: licensorRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (ledgerRes.error !== null) {
      authedLog.error('Ledger entries query failed', { error: ledgerRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (locksRes.error !== null) {
      authedLog.error('Lock records query failed', { error: locksRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 9: Compute per-unit royalty and assemble unit_sales ────────────────

    const ledgerEntries = (ledgerRes.data ?? []) as LedgerEntry[]

    const unitSales = ledgerEntries.map((le) => ({
      ledger_entry_id:    le.id,
      unit_id:            le.unit_id,
      serial_number:      le.serial_number,
      sku:                le.sku,
      product_name:       le.product_name,
      retail_price_cents: le.retail_price_cents,
      royalty_rate:       le.royalty_rate,
      // Per-unit royalty: retail × rate, rounded to nearest cent
      royalty_cents: le.retail_price_cents !== null
        ? Math.round(le.retail_price_cents * le.royalty_rate)
        : null,
      occurred_at: le.occurred_at,
    }))

    // ── Step 10: Assemble report ────────────────────────────────────────────────

    const activeLocks = locksRes.data ?? []

    authedLog.info('CLC report assembled', {
      period_start:      entry.period_start,
      period_end:        entry.period_end,
      units_sold:        entry.units_sold,
      unit_sales_detail: unitSales.length,
      active_locks:      activeLocks.length,
      remittance_cents:  entry.remittance_cents,
      status:            entry.status,
    })

    return jsonResponse(req, {
      report: {
        generated_at:     new Date().toISOString(),
        license_body:     'CLC',
        period_start:     entry.period_start,
        period_end:       entry.period_end,
        reporting_period: entry.reporting_period,
      },
      licensor: licensorRes.data,
      royalty_entry: {
        id:                        entry.id,
        units_sold:                entry.units_sold,
        gross_sales_cents:         entry.gross_sales_cents,
        royalty_rate:              entry.royalty_rate,
        royalty_cents:             entry.royalty_cents,
        remittance_cents:          entry.remittance_cents,
        minimum_applied:           entry.minimum_applied,
        status:                    entry.status,
        licensor_reference_id:     entry.licensor_reference_id,
        submitted_at:              entry.submitted_at,
        submitted_by:              entry.submitted_by,
        paid_at:                   entry.paid_at,
        payment_reference:         entry.payment_reference,
        dispute_note:              entry.dispute_note,
        resolution_note:           entry.resolution_note,
        adjusted_remittance_cents: entry.adjusted_remittance_cents,
        created_at:                entry.created_at,
        updated_at:                entry.updated_at,
      },
      unit_sales:   unitSales,
      active_locks: activeLocks,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
