/**
 * GTG Edge Function — generate-invoice-record
 *
 * Monthly invoice generation — compute and persist (3E-4 persist step).
 * Runs aggregate_ledger_month, then calculate_gross_month and
 * calculate_royalties_month, assembles the summary block, then persists the
 * compiled statement as a monthly_invoices row via create_monthly_invoice.
 *
 * ─── Pipeline position ────────────────────────────────────────────────────────
 *
 *   3E-1  aggregate-ledger-by-month   raw per-dimension aggregations
 *   3E-2  calculate-gross             gross/net financial figures
 *   3E-3  calculate-royalties-owed    per-licensor royalty obligations
 *   3E-4  compile-monthly-invoice     read-only compiled statement (inspect only)
 *   3E-4  generate-invoice-record  ←─ compile + persist (this function)
 *
 * ─── Relationship to compile-monthly-invoice ──────────────────────────────────
 *
 * compile-monthly-invoice is a read-only inspection tool — it returns the
 * compiled statement without writing anything. generate-invoice-record performs
 * the same computation and then persists it. Use compile first to preview the
 * invoice before committing it to the ledger.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * If a monthly_invoices row already exists for the requested period, the DB
 * function returns was_created = false with the existing invoice_id and status.
 * This function surfaces that signal in the response — the caller can inspect
 * the existing invoice without error.
 *
 * An existing 'draft' invoice is NOT overwritten. To regenerate (e.g. after a
 * ledger correction), the existing invoice must be voided first via a separate
 * admin action. This prevents silent financial restatements.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Persisting the monthly invoice is a write action that drives payout and
 * licensor submission decisions.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/generate-invoice-record
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "year_month": "2026-03" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "invoice_id":   "<uuid>",
 *       "was_created":  true,
 *       "status":       "draft",
 *       "year_month":   "2026-03",
 *       "period_start": "2026-03-01",
 *       "period_end":   "2026-03-31",
 *       "summary": {
 *         "net_sales_cents":                  619856,
 *         "total_royalties_remittance_cents": 88174,
 *         "total_net_commission_cents":       162236,
 *         "approved_payable_cents":           15990,
 *         "net_platform_cents":               369446
 *       }
 *     }
 *   }
 *
 *   200 {                                   ← already exists (was_created = false)
 *     "data": {
 *       "invoice_id":   "<uuid>",
 *       "was_created":  false,
 *       "status":       "draft",
 *       "year_month":   "2026-03",
 *       "period_start": "2026-03-01",
 *       "period_end":   "2026-03-31",
 *       "summary":      null               ← not recomputed for existing records
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing year_month, invalid format)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   500  Internal server error (which DB function failed is logged)
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

// ── From aggregate_ledger_month ───────────────────────────────────────────────

interface AggregateResult {
  year_month: string
  sales_totals: {
    units_sold: number
    gross_sales_cents: number
  }
  by_consultant: unknown[]
}

// ── From calculate_gross_month ─────────────────────────────────────────────────

interface RevenueSection {
  gross_sales_cents:   number
  returns_cents:       number
  net_sales_cents:     number
  by_license_body:     unknown[]
}

interface CommissionsSection {
  gross_accrued_cents:           number
  reversals_this_period_cents:   number
  net_commission_cents:          number
  approved_payable_cents:        number
  held_cents:                    number
  by_consultant_accrued:         unknown[]
  by_consultant_reversals:       unknown[]
}

interface GrossResult {
  year_month:   string
  period_start: string
  period_end:   string
  revenue:      RevenueSection
  commissions:  CommissionsSection
}

// ── From calculate_royalties_month ─────────────────────────────────────────────

interface RoyaltyEntry {
  remittance_cents: number
  [key: string]: unknown
}

interface RoyaltiesResult {
  year_month:   string
  period_start: string
  period_end:   string
  royalties:    RoyaltyEntry[]
}

// ── From create_monthly_invoice (DB row) ───────────────────────────────────────

interface InvoiceRow {
  invoice_id:  string
  was_created: boolean
  status:      string
}

// ── Response ───────────────────────────────────────────────────────────────────

interface SummaryBlock {
  net_sales_cents:                  number
  total_royalties_remittance_cents: number
  total_net_commission_cents:       number
  approved_payable_cents:           number
  net_platform_cents:               number
}

interface InvoiceResponsePayload {
  invoice_id:   string
  was_created:  boolean
  status:       string
  year_month:   string
  period_start: string
  period_end:   string
  summary:      SummaryBlock | null
}

interface CalculatedTotals {
  total_royalties_remittance_cents: number
  summary: SummaryBlock
}

function calculateInvoiceTotals(
  gross: GrossResult,
  royalties: RoyaltiesResult,
): CalculatedTotals {
  const totalRoyaltiesRemittanceCents = royalties.royalties.reduce(
    (sum, r) => sum + r.remittance_cents,
    0,
  )

  const summary: SummaryBlock = {
    net_sales_cents:                  gross.revenue.net_sales_cents,
    total_royalties_remittance_cents: totalRoyaltiesRemittanceCents,
    total_net_commission_cents:       gross.commissions.net_commission_cents,
    approved_payable_cents:           gross.commissions.approved_payable_cents,
    net_platform_cents:
      gross.revenue.net_sales_cents
      - totalRoyaltiesRemittanceCents
      - gross.commissions.net_commission_cents,
  }

  return {
    total_royalties_remittance_cents: totalRoyaltiesRemittanceCents,
    summary,
  }
}

interface InsertInvoiceInput {
  year_month: string
  gross: GrossResult
  royalties: RoyaltiesResult
  totals: CalculatedTotals
  created_by: string
}

async function insertInvoiceRecord(
  admin: ReturnType<typeof createAdminClient>,
  input: InsertInvoiceInput,
): Promise<InvoiceRow> {
  const { data: rows, error } = await admin.rpc('create_monthly_invoice', {
    p_year_month:                       input.year_month,
    p_period_start:                     input.gross.period_start,
    p_period_end:                       input.gross.period_end,
    p_gross_sales_cents:                input.gross.revenue.gross_sales_cents,
    p_returns_cents:                    input.gross.revenue.returns_cents,
    p_net_sales_cents:                  input.gross.revenue.net_sales_cents,
    p_gross_accrued_cents:              input.gross.commissions.gross_accrued_cents,
    p_reversals_this_period_cents:      input.gross.commissions.reversals_this_period_cents,
    p_net_commission_cents:             input.gross.commissions.net_commission_cents,
    p_approved_payable_cents:           input.gross.commissions.approved_payable_cents,
    p_held_cents:                       input.gross.commissions.held_cents,
    p_total_royalties_remittance_cents: input.totals.total_royalties_remittance_cents,
    p_net_platform_cents:               input.totals.summary.net_platform_cents,
    p_revenue_snapshot:                 input.gross.revenue,
    p_commissions_snapshot:             input.gross.commissions,
    p_royalties_snapshot:               input.royalties.royalties,
    p_created_by:                       input.created_by,
  })

  if (error !== null) {
    throw error
  }

  return (rows as InvoiceRow[])[0]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('generate-invoice-record', req)
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

    // ── Step 6: 5E-1 Aggregate ledger by month ─────────────────────────────────
    // This is the canonical raw monthly aggregation used by downstream invoice
    // computations. We execute it first to ensure the month is aggregatable
    // before entering calculate_gross_month / calculate_royalties_month.

    const admin = createAdminClient()

    const { data: aggregateData, error: aggregateError } = await admin.rpc(
      'aggregate_ledger_month',
      { p_year_month: body.year_month },
    )

    if (aggregateError !== null) {
      const gtgMatch = aggregateError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('aggregate_ledger_month failed', { error: aggregateError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const aggregate = aggregateData as AggregateResult

    authedLog.info('Monthly ledger aggregated', {
      year_month: body.year_month,
      units_sold: aggregate.sales_totals.units_sold,
      gross_sales_cents: aggregate.sales_totals.gross_sales_cents,
      consultant_count: aggregate.by_consultant.length,
    })

    // ── Step 7: Compute financial totals in parallel ────────────────────────────

    authedLog.info('Computing monthly invoice', { year_month: body.year_month })

    const [grossRes, royaltiesRes] = await Promise.all([
      admin.rpc('calculate_gross_month',     { p_year_month: body.year_month }),
      admin.rpc('calculate_royalties_month', { p_year_month: body.year_month }),
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

    // ── Step 8: 5E-2 Calculate totals ─────────────────────────────────────────

    const totals = calculateInvoiceTotals(gross, royalties)
    const summary = totals.summary

    // Soft consistency check: aggregate_ledger_month and calculate_gross_month
    // should report the same gross monthly sales.
    if (aggregate.sales_totals.gross_sales_cents !== gross.revenue.gross_sales_cents) {
      authedLog.warn('Aggregation mismatch detected', {
        aggregate_gross_sales_cents: aggregate.sales_totals.gross_sales_cents,
        gross_fn_gross_sales_cents:  gross.revenue.gross_sales_cents,
      })
    }

    authedLog.info('Invoice computed', {
      year_month:                        body.year_month,
      net_sales_cents:                   summary.net_sales_cents,
      total_royalties_remittance_cents:  summary.total_royalties_remittance_cents,
      total_net_commission_cents:        summary.total_net_commission_cents,
      approved_payable_cents:            summary.approved_payable_cents,
      net_platform_cents:                summary.net_platform_cents,
    })

    // ── Step 9: 5E-3 Insert invoice record ─────────────────────────────────────
    let row: InvoiceRow
    try {
      row = await insertInvoiceRecord(admin, {
        year_month: body.year_month,
        gross,
        royalties,
        totals,
        created_by: authorized.id,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const gtgMatch = message.match(/\[GTG\][^.]+\./)
      authedLog.error('create_monthly_invoice failed', { error: message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    authedLog.info('Invoice record persisted', {
      invoice_id:  row.invoice_id,
      was_created: row.was_created,
      status:      row.status,
      year_month:  body.year_month,
    })

    const payload: InvoiceResponsePayload = {
      invoice_id:   row.invoice_id,
      was_created:  row.was_created,
      status:       row.status,
      year_month:   gross.year_month,
      period_start: gross.period_start,
      period_end:   gross.period_end,
      // Summary is included when freshly created; omitted for existing records
      // since the existing record's figures are authoritative (not recomputed here).
      summary:      row.was_created ? summary : null,
    }

    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
