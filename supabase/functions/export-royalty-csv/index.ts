/**
 * GTG Edge Function — export-royalty-csv
 *
 * CSV export of royalty unit-sale detail for licensor submission (4D-3).
 * Exports the same underlying data as generate-clc-report / generate-army-report
 * but formatted as a UTF-8 CSV file suitable for direct licensor submission
 * or import into reconciliation tooling.
 *
 * ─── Output format ────────────────────────────────────────────────────────────
 *
 * The CSV contains two sections separated by a blank row:
 *
 *   Metadata block   Labeled key-value rows identifying the report, period,
 *                    licensor, and computed totals. Opens cleanly in Excel
 *                    as a self-documenting header.
 *
 *   Detail block     Column headers followed by one row per unit sold.
 *                    Amounts in USD dollars (not cents) for licensor readability.
 *                    Royalty rate as a percentage string (e.g. "14.50%").
 *
 * Line endings: CRLF (\r\n) for maximum Excel / Windows compatibility.
 * Encoding: UTF-8 with BOM (\uFEFF) so Excel auto-detects the encoding.
 *
 * ─── Period lookup ────────────────────────────────────────────────────────────
 *
 * Accepts year_month (YYYY-MM). The royalty_entry is located by finding the
 * entry for the given license_body whose period_start ≤ first-day-of-month
 * ≤ period_end. For CLC (quarterly), any month in the quarter returns the
 * quarterly report. For Army (monthly), the month maps to exactly one entry.
 *
 * If no royalty_entry exists for the period, a 404 JSON response is returned.
 * Run calculate-royalties-owed (3E-3) and generate-invoice-record (3E-4) first.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/export-royalty-csv
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "license_body": "CLC",    // "CLC" or "ARMY"
 *     "year_month":   "2026-01"
 *   }
 *
 * ─── Response (success) ───────────────────────────────────────────────────────
 *
 *   200
 *   Content-Type: text/csv; charset=utf-8
 *   Content-Disposition: attachment; filename="GTG-CLC-2026-01-royalty.csv"
 *
 *   (body)
 *   Report,GTG Royalty Report — CLC
 *   Period,2026-01-01 to 2026-03-31
 *   Reporting Cadence,Quarterly
 *   Generated,2026-03-06
 *   Licensor,Collegiate Licensing Company
 *   Contact,licensing@clc.com
 *   Status,calculated
 *   ,
 *   Units Sold,47
 *   Gross Sales (USD),2349.53
 *   Calculated Royalty (USD),340.68
 *   Remittance Due (USD),500.00
 *   Minimum Floor Applied,Yes
 *   ,
 *   Serial Number,SKU,Product Name,Sale Date,Retail Price (USD),Royalty Rate,Royalty Amount (USD)
 *   GTG-CLC-2026-0001,APP-NIKE-JERSEY-M,Nike Jersey — Medium,2026-02-15,49.99,14.50%,7.24
 *   ...
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (JSON)
 *   401  Unauthenticated (JSON)
 *   403  Forbidden (JSON)
 *   404  No royalty entry found for the period (JSON)
 *   500  Internal server error (JSON)
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const YEAR_MONTH_RE  = /^\d{4}-(0[1-9]|1[0-2])$/
const VALID_LICENSORS = new Set(['CLC', 'ARMY'])

const LICENSOR_DISPLAY: Record<string, string> = {
  CLC:  'CLC',
  ARMY: 'ARMY',
}

const CADENCE_DISPLAY: Record<string, string> = {
  monthly:   'Monthly',
  quarterly: 'Quarterly',
  annual:    'Annual',
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  license_body?: string
  year_month?:   string
}

interface RoyaltyEntry {
  id:                        string
  license_holder_id:         string
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
}

interface LicensorRow {
  legal_name:      string
  contact_email:   string
  reporting_period: string
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

// ─── CSV helpers ──────────────────────────────────────────────────────────────

/** Wrap a cell in double-quotes if it contains a comma, quote, or newline. */
function escapeCell(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function row(...cells: string[]): string {
  return cells.map(escapeCell).join(',')
}

function blank(): string {
  return ','
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}

function rateToPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

function isoDateOnly(isoString: string): string {
  return isoString.slice(0, 10)
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('export-royalty-csv', req)
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

    if (!body.license_body || typeof body.license_body !== 'string' ||
        !VALID_LICENSORS.has(body.license_body.toUpperCase())) {
      return jsonError(
        req,
        "license_body is required and must be 'CLC' or 'ARMY'.",
        400,
      )
    }

    const licenseBody = body.license_body.toUpperCase()

    if (!body.year_month || typeof body.year_month !== 'string' ||
        !YEAR_MONTH_RE.test(body.year_month)) {
      return jsonError(
        req,
        "year_month is required and must be in YYYY-MM format (e.g. '2026-03').",
        400,
      )
    }

    const yearMonth = body.year_month

    // Derive first day of the given month as the period probe point
    const [year, month] = yearMonth.split('-').map(Number)
    const probeDate = `${year}-${String(month).padStart(2, '0')}-01`

    const admin = createAdminClient()

    // ── Step 6: Fetch royalty entry for the period ──────────────────────────────

    authedLog.info('Fetching royalty entry', {
      license_body: licenseBody,
      year_month:   yearMonth,
      probe_date:   probeDate,
    })

    const { data: royaltyEntry, error: royaltyError } = await admin
      .from('royalty_entries')
      .select(
        'id, license_holder_id, reporting_period, ' +
        'period_start, period_end, ledger_entry_ids, ' +
        'units_sold, gross_sales_cents, royalty_rate, royalty_cents, ' +
        'remittance_cents, minimum_applied, status',
      )
      .eq('license_body', licenseBody)
      .lte('period_start', probeDate)
      .gte('period_end', probeDate)
      .neq('status', 'voided')
      .order('period_start', { ascending: false })
      .limit(1)
      .single()

    if (royaltyError !== null) {
      if (royaltyError.code === 'PGRST116') {
        authedLog.warn('No royalty entry found', { license_body: licenseBody, year_month: yearMonth })
        return jsonError(
          req,
          `No ${LICENSOR_DISPLAY[licenseBody]} royalty entry found for a period containing ${yearMonth}. ` +
          'Run calculate-royalties-owed (3E-3) and generate-invoice-record (3E-4) ' +
          'to produce the royalty entry before exporting.',
          404,
        )
      }
      authedLog.error('Royalty entry query failed', { error: royaltyError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const entry = royaltyEntry as RoyaltyEntry
    const ledgerIds: string[] = entry.ledger_entry_ids ?? []

    // ── Step 7: Parallel fetch — licensor details + ledger unit-sale rows ────────

    const [licensorRes, ledgerRes] = await Promise.all([

      admin
        .from('license_holders')
        .select('legal_name, contact_email, reporting_period')
        .eq('license_body', licenseBody)
        .eq('is_active', true)
        .order('rate_effective_date', { ascending: false })
        .limit(1)
        .single(),

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
    ])

    // ── Step 8: Handle query errors ─────────────────────────────────────────────

    if (licensorRes.error !== null) {
      authedLog.error('Licensor query failed', { error: licensorRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (ledgerRes.error !== null) {
      authedLog.error('Ledger entries query failed', { error: ledgerRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const licensor = licensorRes.data as LicensorRow
    const ledgerEntries = (ledgerRes.data ?? []) as LedgerEntry[]

    // ── Step 9: Build CSV ───────────────────────────────────────────────────────

    const generatedDate = isoDateOnly(new Date().toISOString())
    const cadence       = CADENCE_DISPLAY[licensor.reporting_period] ?? licensor.reporting_period

    const lines: string[] = []

    // UTF-8 BOM — ensures Excel opens the file with correct encoding
    lines.push('\uFEFF')

    // ── Metadata block ──
    lines.push(row('Report',              `GTG Royalty Report \u2014 ${licenseBody}`))
    lines.push(row('Period',              `${entry.period_start} to ${entry.period_end}`))
    lines.push(row('Reporting Cadence',   cadence))
    lines.push(row('Generated',           generatedDate))
    lines.push(row('Licensor',            licensor.legal_name))
    lines.push(row('Contact',             licensor.contact_email))
    lines.push(row('Status',              entry.status))

    lines.push(blank())

    // ── Totals summary ──
    lines.push(row('Units Sold',                String(entry.units_sold)))
    lines.push(row('Gross Sales (USD)',          centsToDollars(entry.gross_sales_cents)))
    lines.push(row('Calculated Royalty (USD)',   centsToDollars(entry.royalty_cents)))
    lines.push(row('Remittance Due (USD)',       centsToDollars(entry.remittance_cents)))
    lines.push(row('Minimum Floor Applied',      entry.minimum_applied ? 'Yes' : 'No'))

    lines.push(blank())

    // ── Detail header ──
    lines.push(row(
      'Serial Number',
      'SKU',
      'Product Name',
      'Sale Date',
      'Retail Price (USD)',
      'Royalty Rate',
      'Royalty Amount (USD)',
    ))

    // ── Detail rows ──
    for (const le of ledgerEntries) {
      const royaltyCents = le.retail_price_cents !== null
        ? Math.round(le.retail_price_cents * le.royalty_rate)
        : 0

      lines.push(row(
        le.serial_number,
        le.sku,
        le.product_name,
        isoDateOnly(le.occurred_at),
        le.retail_price_cents !== null ? centsToDollars(le.retail_price_cents) : '',
        rateToPercent(le.royalty_rate),
        centsToDollars(royaltyCents),
      ))
    }

    // Join with CRLF for maximum CSV compatibility
    const csvBody = lines.join('\r\n')

    // ── Step 10: Return CSV response ────────────────────────────────────────────

    const filename = `GTG-${licenseBody}-${yearMonth}-royalty.csv`

    authedLog.info('CSV export ready', {
      license_body:    licenseBody,
      period_start:    entry.period_start,
      period_end:      entry.period_end,
      units_sold:      entry.units_sold,
      detail_rows:     ledgerEntries.length,
      filename,
    })

    // CORS origin header — mirror the request origin (same logic as jsonResponse)
    const origin     = req.headers.get('origin') ?? '*'
    const corsHeader = origin !== '*' ? origin : '*'

    return new Response(csvBody, {
      status: 200,
      headers: {
        'Content-Type':                 'text/csv; charset=utf-8',
        'Content-Disposition':          `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin':  corsHeader,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
