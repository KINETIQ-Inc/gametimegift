/**
 * GTG Edge Function — get-consultant-commission-earned
 *
 * Commission earned dashboard widget for the consultant portal real-time
 * dashboard (6B-2). Returns a period breakdown of commission entries by
 * status, lifetime totals, and a recent entries feed.
 *
 * ─── Response shape ───────────────────────────────────────────────────────────
 *
 *   period_summary   Aggregate figures for the requested date range, computed
 *                    by the get_consultant_commission_summary DB function
 *                    (migration 42). Broken down by status (earned / paid /
 *                    voided) plus a net_cents convenience field.
 *
 *   lifetime         Pre-computed running totals from consultant_profiles.
 *                    Fast single-row read; updated transactionally with every
 *                    sale and payout.
 *
 *   recent_entries   Last 10 commission entries attributed to this consultant,
 *                    most recent first. commission_entries already denormalises
 *                    product and order identifiers so no join is needed.
 *
 * ─── Period selection ─────────────────────────────────────────────────────────
 *
 *   period_start   YYYY-MM-DD  Start of the period (inclusive). UTC calendar date.
 *   period_end     YYYY-MM-DD  End of the period (inclusive). UTC calendar date.
 *
 *   Both are optional. Defaults: first day of the current UTC calendar month
 *   through today. Maximum range: 366 days.
 *
 *   The DB query uses: created_at >= period_start 00:00:00 UTC
 *                      created_at <  period_end   00:00:00 UTC + 1 day
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 *   consultant    Retrieves their own dashboard. No consultant_id in body.
 *   admin         May retrieve any consultant's dashboard by passing consultant_id.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-consultant-commission-earned
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   Consultant (own dashboard):
 *   { "period_start": "2026-03-01", "period_end": "2026-03-31" }
 *
 *   Admin (any consultant):
 *   { "consultant_id": "<uuid>", "period_start": "2026-03-01", "period_end": "2026-03-31" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "consultant_id":  "<uuid>",
 *       "display_name":   "Jane S.",
 *       "period": {
 *         "start": "2026-03-01",
 *         "end":   "2026-03-31"
 *       },
 *       "period_summary": {
 *         "entries_count": 12,
 *         "earned_cents":  5999,
 *         "paid_cents":    0,
 *         "voided_cents":  0,
 *         "net_cents":     5999
 *       },
 *       "lifetime": {
 *         "gross_sales_cents":    419916,
 *         "commissions_cents":    41992,
 *         "pending_payout_cents": 5999
 *       },
 *       "recent_entries": [
 *         {
 *           "entry_id":           "<uuid>",
 *           "order_id":           "<uuid>",
 *           "order_number":       "GTG-20260305-000042",
 *           "serial_number":      "GTG-CLC-2026-0042",
 *           "sku":                "APP-NIKE-JERSEY-M",
 *           "product_name":       "Nike Jersey — Medium",
 *           "retail_price_cents": 4999,
 *           "commission_tier":    "standard",
 *           "commission_rate":    0.10,
 *           "commission_cents":   500,
 *           "status":             "earned",
 *           "created_at":         "2026-03-05T14:22:11Z"
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (invalid date format, range too large, etc.)
 *   401  Unauthenticated
 *   403  Forbidden (role not permitted)
 *   404  Consultant profile not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, extractRole, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 366
const RECENT_LIMIT   = 10

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id?: unknown
  period_start?:  unknown
  period_end?:    unknown
}

interface ConsultantRow {
  id:                        string
  display_name:              string
  lifetime_gross_sales_cents: number
  lifetime_commissions_cents: number
  pending_payout_cents:      number
}

interface SummaryRow {
  entries_count: number
  earned_cents:  number
  paid_cents:    number
  voided_cents:  number
}

interface CommissionEntryRow {
  id:                 string
  order_id:           string
  order_number:       string
  serial_number:      string
  sku:                string
  product_name:       string
  retail_price_cents: number
  commission_tier:    string
  commission_rate:    number
  commission_cents:   number
  status:             string
  created_at:         string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a YYYY-MM-DD string into a UTC Date, or return null if invalid. */
function parseDate(raw: string): Date | null {
  if (!DATE_RE.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  return isNaN(d.getTime()) ? null : d
}

/** Returns the first day of the current UTC calendar month. */
function startOfCurrentMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Returns today's UTC date at midnight. */
function startOfToday(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Adds one day to a UTC Date. */
function addOneDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000)
}

/** Format a Date as YYYY-MM-DD. */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Difference in days between two dates (b - a). */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('get-consultant-commission-earned', req)
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

    // ── Step 4: Authorize ───────────────────────────────────────────────────

    const role    = extractRole(user)
    const isAdmin = role === 'admin' || role === 'super_admin'

    if (role !== 'consultant' && !isAdmin) {
      log.warn('Forbidden role', { user_id: user.id, role })
      const { denied } = verifyRole(user, [...ADMIN_ROLES, 'consultant'], req)
      return denied!
    }

    const authedLog = log.withUser(user.id)
    authedLog.info('Authenticated', { role })

    // ── Step 5: Parse body ──────────────────────────────────────────────────

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      // Empty body — defaults apply.
    }

    // consultant_id only honoured for admins.
    if (body.consultant_id !== undefined && !isAdmin) {
      body = { ...body, consultant_id: undefined }
    }

    if (body.consultant_id !== undefined && body.consultant_id !== null) {
      if (typeof body.consultant_id !== 'string' || !UUID_RE.test(body.consultant_id)) {
        return jsonError(req, 'consultant_id must be a valid UUID when provided.', 400)
      }
    }

    // ── Step 6: Resolve and validate period ─────────────────────────────────
    // Default: first day of current UTC month → today (inclusive).

    const defaultStart = startOfCurrentMonth()
    const defaultEnd   = startOfToday()

    let periodStart: Date
    let periodEnd:   Date

    if (body.period_start !== undefined && body.period_start !== null) {
      if (typeof body.period_start !== 'string') {
        return jsonError(req, 'period_start must be a string in YYYY-MM-DD format.', 400)
      }
      const parsed = parseDate(body.period_start)
      if (!parsed) {
        return jsonError(req, 'period_start must be a valid date in YYYY-MM-DD format.', 400)
      }
      periodStart = parsed
    } else {
      periodStart = defaultStart
    }

    if (body.period_end !== undefined && body.period_end !== null) {
      if (typeof body.period_end !== 'string') {
        return jsonError(req, 'period_end must be a string in YYYY-MM-DD format.', 400)
      }
      const parsed = parseDate(body.period_end)
      if (!parsed) {
        return jsonError(req, 'period_end must be a valid date in YYYY-MM-DD format.', 400)
      }
      periodEnd = parsed
    } else {
      periodEnd = defaultEnd
    }

    if (periodEnd < periodStart) {
      return jsonError(req, 'period_end must be on or after period_start.', 400)
    }

    if (daysBetween(periodStart, periodEnd) > MAX_RANGE_DAYS) {
      return jsonError(
        req,
        `Period range must not exceed ${MAX_RANGE_DAYS} days.`,
        400,
      )
    }

    // DB query uses created_at >= start AND created_at < end+1day for inclusive end.
    const startAt = periodStart.toISOString()
    const endAt   = addOneDay(periodEnd).toISOString()

    // ── Step 7: Resolve consultant profile ──────────────────────────────────

    const admin = createAdminClient()

    let profileQuery = admin
      .from('consultant_profiles')
      .select('id, display_name, lifetime_gross_sales_cents, lifetime_commissions_cents, pending_payout_cents')

    if (isAdmin && body.consultant_id) {
      profileQuery = profileQuery.eq('id', body.consultant_id as string)
    } else {
      profileQuery = profileQuery.eq('auth_user_id', user.id)
    }

    const { data: profileData, error: profileError } = await profileQuery.single()

    if (profileError !== null || profileData === null) {
      authedLog.warn('Consultant profile not found', { error: profileError?.message })
      return jsonError(req, 'Consultant profile not found.', 404)
    }

    const profile = profileData as ConsultantRow

    // ── Step 8: Fetch period summary and recent entries in parallel ──────────
    // Both queries use the resolved profile.id so they can run concurrently.

    const [summaryResult, entriesResult] = await Promise.all([
      admin.rpc('get_consultant_commission_summary', {
        p_consultant_id: profile.id,
        p_start_at:      startAt,
        p_end_at:        endAt,
      }),
      admin
        .from('commission_entries')
        .select(`
          id,
          order_id,
          order_number,
          serial_number,
          sku,
          product_name,
          retail_price_cents,
          commission_tier,
          commission_rate,
          commission_cents,
          status,
          created_at
        `)
        .eq('consultant_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT),
    ])

    if (summaryResult.error !== null) {
      authedLog.error('Commission summary RPC failed', { error: summaryResult.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (entriesResult.error !== null) {
      authedLog.error('Recent commission entries query failed', { error: entriesResult.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const summary = ((summaryResult.data as SummaryRow[]) ?? [])[0] ?? {
      entries_count: 0,
      earned_cents:  0,
      paid_cents:    0,
      voided_cents:  0,
    }

    const recentEntries = ((entriesResult.data ?? []) as CommissionEntryRow[]).map((e) => ({
      entry_id:           e.id,
      order_id:           e.order_id,
      order_number:       e.order_number,
      serial_number:      e.serial_number,
      sku:                e.sku,
      product_name:       e.product_name,
      retail_price_cents: e.retail_price_cents,
      commission_tier:    e.commission_tier,
      commission_rate:    Number(e.commission_rate),
      commission_cents:   Number(e.commission_cents),
      status:             e.status,
      created_at:         e.created_at,
    }))

    authedLog.info('Commission dashboard fetched', {
      consultant_id:  profile.id,
      period_start:   toDateString(periodStart),
      period_end:     toDateString(periodEnd),
      entries_count:  summary.entries_count,
      earned_cents:   summary.earned_cents,
      recent_fetched: recentEntries.length,
    })

    return jsonResponse(req, {
      consultant_id: profile.id,
      display_name:  profile.display_name,
      period: {
        start: toDateString(periodStart),
        end:   toDateString(periodEnd),
      },
      period_summary: {
        entries_count: Number(summary.entries_count),
        earned_cents:  Number(summary.earned_cents),
        paid_cents:    Number(summary.paid_cents),
        voided_cents:  Number(summary.voided_cents),
        net_cents:     Number(summary.earned_cents) + Number(summary.paid_cents),
      },
      lifetime: {
        gross_sales_cents:    profile.lifetime_gross_sales_cents,
        commissions_cents:    profile.lifetime_commissions_cents,
        pending_payout_cents: profile.pending_payout_cents,
      },
      recent_entries: recentEntries,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
