/**
 * GTG Edge Function — get-consultant-units-sold
 *
 * Units sold dashboard widget for the consultant portal real-time dashboard (6B-1).
 * Returns period summary figures, lifetime totals, and a recent orders feed
 * for a consultant's sales activity.
 *
 * ─── Response shape ───────────────────────────────────────────────────────────
 *
 *   period_summary   Aggregate figures for the requested date range, computed
 *                    by the get_consultant_sales_summary DB function (migration 41).
 *                    Includes: orders_count, units_sold, gross_sales_cents,
 *                    commission_cents.
 *
 *   lifetime         Pre-computed running totals from consultant_profiles.
 *                    Fast single-row read; updated transactionally with every sale.
 *
 *   recent_orders    Last 10 paid/fulfilling/fulfilled orders attributed to this
 *                    consultant, each with its primary line's unit detail.
 *                    Ordered most-recent-first. Used for the activity feed.
 *
 * ─── Period selection ─────────────────────────────────────────────────────────
 *
 *   period_start   YYYY-MM-DD  Start of the period (inclusive). UTC calendar date.
 *   period_end     YYYY-MM-DD  End of the period (inclusive). UTC calendar date.
 *
 *   Both are optional. Defaults: first day of the current UTC calendar month
 *   through today. Maximum range: 366 days.
 *
 *   The DB query uses: paid_at >= period_start 00:00:00 UTC
 *                      paid_at <  period_end   00:00:00 UTC + 1 day
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 *   consultant    Retrieves their own dashboard. No consultant_id in body.
 *   admin         May retrieve any consultant's dashboard by passing consultant_id.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-consultant-units-sold
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
 *       "consultant_id":   "<uuid>",
 *       "display_name":    "Jane S.",
 *       "period": {
 *         "start": "2026-03-01",
 *         "end":   "2026-03-31"
 *       },
 *       "period_summary": {
 *         "orders_count":      12,
 *         "units_sold":        12,
 *         "gross_sales_cents": 59988,
 *         "commission_cents":  5999
 *       },
 *       "lifetime": {
 *         "gross_sales_cents":  419916,
 *         "commissions_cents":  41992,
 *         "pending_payout_cents": 5999
 *       },
 *       "recent_orders": [
 *         {
 *           "order_id":           "<uuid>",
 *           "order_number":       "GTG-20260305-000042",
 *           "status":             "paid",
 *           "paid_at":            "2026-03-05T14:22:11Z",
 *           "product_name":       "Nike Jersey — Medium",
 *           "serial_number":      "GTG-CLC-2026-0042",
 *           "sku":                "APP-NIKE-JERSEY-M",
 *           "retail_price_cents": 4999,
 *           "commission_cents":   500
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

const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 366
const RECENT_LIMIT   = 10

// Statuses included in the recent_orders feed.
const ACTIVE_ORDER_STATUSES = ['paid', 'fulfilling', 'fulfilled', 'partially_returned']

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
  orders_count:      number
  units_sold:        number
  gross_sales_cents: number
  commission_cents:  number
}

interface OrderRow {
  id:           string
  order_number: string
  status:       string
  paid_at:      string | null
  order_lines:  OrderLineRow[]
}

interface OrderLineRow {
  serial_number:      string
  sku:                string
  product_name:       string
  retail_price_cents: number
  commission_cents:   number | null
  status:             string
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

  const log = createLogger('get-consultant-units-sold', req)
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

    // DB query uses paid_at >= start AND paid_at < end+1day for inclusive end.
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

    // Run profile fetch and period aggregate in parallel.
    const [profileResult, summaryResult] = await Promise.all([
      profileQuery.single(),
      admin.rpc('get_consultant_sales_summary', {
        p_consultant_id: (isAdmin && body.consultant_id) ? body.consultant_id as string : null,
        p_start_at:      startAt,
        p_end_at:        endAt,
      }),
    ])

    // Profile must resolve before we can use its id for the summary RPC.
    // If the profile is not found yet, bail early.
    if (profileResult.error !== null || profileResult.data === null) {
      authedLog.warn('Consultant profile not found', { error: profileResult.error?.message })
      return jsonError(req, 'Consultant profile not found.', 404)
    }

    const profile = profileResult.data as ConsultantRow

    // ── Step 8: Re-run summary with resolved profile id if needed ────────────
    // The parallel call above passes null for consultant profile id when the
    // consultant is looking up their own data (we hadn't resolved the profile id yet).
    // Resolve it now and re-run the RPC with the correct id.

    let summaryData = summaryResult.data
    let summaryError = summaryResult.error

    if (
      summaryError === null &&
      (!isAdmin || !body.consultant_id)
    ) {
      // Re-run with the resolved profile id.
      const { data, error } = await admin.rpc('get_consultant_sales_summary', {
        p_consultant_id: profile.id,
        p_start_at:      startAt,
        p_end_at:        endAt,
      })
      summaryData  = data
      summaryError = error
    }

    if (summaryError !== null) {
      authedLog.error('Sales summary RPC failed', { error: summaryError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const summary = ((summaryData as SummaryRow[]) ?? [])[0] ?? {
      orders_count:      0,
      units_sold:        0,
      gross_sales_cents: 0,
      commission_cents:  0,
    }

    // ── Step 9: Fetch recent orders with line detail ─────────────────────────
    // Last RECENT_LIMIT orders for this consultant, most recent first.
    // Each order returns its order_lines so the feed can show product detail.
    // Supabase inline join syntax: order_lines(fields...).

    const { data: ordersData, error: ordersError } = await admin
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        paid_at,
        order_lines (
          serial_number,
          sku,
          product_name,
          retail_price_cents,
          commission_cents,
          status
        )
      `)
      .eq('consultant_id', profile.id)
      .eq('channel', 'consultant_assisted')
      .in('status', ACTIVE_ORDER_STATUSES)
      .order('paid_at', { ascending: false })
      .limit(RECENT_LIMIT)

    if (ordersError !== null) {
      authedLog.error('Recent orders query failed', { error: ordersError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // Flatten to a single-entry-per-order shape for the feed.
    // Each order selects its first non-cancelled line for display.
    const recentOrders = ((ordersData ?? []) as OrderRow[]).map((order) => {
      const line = order.order_lines.find((l) => l.status !== 'cancelled') ?? order.order_lines[0]
      return {
        order_id:           order.id,
        order_number:       order.order_number,
        status:             order.status,
        paid_at:            order.paid_at,
        product_name:       line?.product_name       ?? null,
        serial_number:      line?.serial_number      ?? null,
        sku:                line?.sku                ?? null,
        retail_price_cents: line?.retail_price_cents ?? null,
        commission_cents:   line?.commission_cents   ?? null,
      }
    })

    authedLog.info('Units sold dashboard fetched', {
      consultant_id:  profile.id,
      period_start:   toDateString(periodStart),
      period_end:     toDateString(periodEnd),
      orders_count:   summary.orders_count,
      units_sold:     summary.units_sold,
      recent_fetched: recentOrders.length,
    })

    return jsonResponse(req, {
      consultant_id:  profile.id,
      display_name:   profile.display_name,
      period: {
        start: toDateString(periodStart),
        end:   toDateString(periodEnd),
      },
      period_summary: {
        orders_count:      Number(summary.orders_count),
        units_sold:        Number(summary.units_sold),
        gross_sales_cents: Number(summary.gross_sales_cents),
        commission_cents:  Number(summary.commission_cents),
      },
      lifetime: {
        gross_sales_cents:   profile.lifetime_gross_sales_cents,
        commissions_cents:   profile.lifetime_commissions_cents,
        pending_payout_cents: profile.pending_payout_cents,
      },
      recent_orders: recentOrders,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
