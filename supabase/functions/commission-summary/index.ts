/**
 * GTG Edge Function — commission-summary
 *
 * Read-only commission reporting endpoint. Returns a structured summary of
 * commission_entries rows, aggregated by status and optionally scoped to a
 * specific order or consultant.
 *
 * ─── Query modes ─────────────────────────────────────────────────────────────
 *
 * Exactly one of order_id or consultant_id must be provided per request.
 *
 * MODE: order
 *   Input:  { order_id: string }
 *   Returns the commission breakdown for a single order — one entry per
 *   commissionable line. Includes per-entry detail and order-level totals
 *   aggregated by commission status. Used by the admin app's order detail view
 *   and by the order processing engine to confirm entries were created.
 *
 * MODE: consultant
 *   Input:  { consultant_id: string, from_date?: string, to_date?: string }
 *   Returns the consultant's commission dashboard: profile running totals
 *   (from consultant_profiles), status breakdown across all commission entries
 *   within the optional date range, and up to 100 recent entries ordered by
 *   creation date descending. Used by the consultant portal and admin reports.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES  — may query any order or consultant.
 * consultant   — mode=order:      may query orders attributed to themselves.
 *                mode=consultant: may query only their own profile.
 * The ownership check runs after the fetch for accurate 404 vs 403 semantics.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/commission-summary
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   // Order mode:
 *   { "order_id": "uuid" }
 *
 *   // Consultant mode:
 *   { "consultant_id": "uuid", "from_date": "2026-01-01", "to_date": "2026-03-31" }
 *
 * ─── Response: order mode ────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "query_mode": "order",
 *       "order_id": "...",
 *       "order_number": "GTG-20260305-000042",
 *       "order_status": "paid",
 *       "consultant_id": "...",
 *       "consultant_name": "Jane Smith",
 *       "commission_tier": "senior",
 *       "effective_rate": 0.15,
 *       "entries": [
 *         {
 *           "commission_entry_id": "...",
 *           "unit_id": "...",
 *           "serial_number": "GTG-ABC123",
 *           "sku": "GTG-001",
 *           "product_name": "Army Football Jersey #12",
 *           "retail_price_cents": 4999,
 *           "commission_cents": 750,
 *           "status": "earned",
 *           "hold_reason": null,
 *           "created_at": "2026-03-05T14:00:00Z"
 *         }
 *       ],
 *       "totals": {
 *         "entry_count": 2,
 *         "total_retail_cents": 9998,
 *         "total_commission_cents": 1500,
 *         "by_status": {
 *           "earned":   1500,
 *           "held":     0,
 *           "approved": 0,
 *           "paid":     0,
 *           "reversed": 0,
 *           "voided":   0
 *         }
 *       }
 *     }
 *   }
 *
 * ─── Response: consultant mode ───────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "query_mode": "consultant",
 *       "consultant_id": "...",
 *       "display_name": "Jane Smith",
 *       "commission_tier": "senior",
 *       "date_range": { "from": "2026-01-01", "to": "2026-03-31" },
 *       "profile_totals": {
 *         "lifetime_gross_sales_cents": 299940,
 *         "lifetime_commissions_cents": 44991,
 *         "pending_payout_cents": 15000
 *       },
 *       "by_status": {
 *         "earned":   { "count": 4, "total_cents": 3000 },
 *         "held":     { "count": 1, "total_cents": 750 },
 *         "approved": { "count": 2, "total_cents": 1500 },
 *         "paid":     { "count": 30, "total_cents": 22500 },
 *         "reversed": { "count": 3, "total_cents": 2250 },
 *         "voided":   { "count": 0, "total_cents": 0 }
 *       },
 *       "recent_entries": [ ... ],
 *       "recent_entry_count": 40
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (neither or both IDs provided, invalid date format)
 *   401  Unauthenticated
 *   403  Forbidden (ownership check failed)
 *   404  Order or consultant not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import type { AppRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ROLES: readonly AppRole[] = ['super_admin', 'admin', 'consultant']

/** All commission statuses in display order. */
const ALL_STATUSES = ['earned', 'held', 'approved', 'paid', 'reversed', 'voided'] as const
type CommissionStatus = typeof ALL_STATUSES[number]

/** Max entries returned in consultant mode to keep responses bounded. */
const CONSULTANT_ENTRY_LIMIT = 100

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  order_id?:      string | null
  consultant_id?: string | null
  from_date?:     string | null
  to_date?:       string | null
}

interface EntryDetail {
  commission_entry_id: string
  unit_id:             string
  serial_number:       string
  sku:                 string
  product_name:        string
  retail_price_cents:  number
  commission_cents:    number
  status:              string
  hold_reason:         string | null
  created_at:          string
}

interface StatusTotals {
  earned:   number
  held:     number
  approved: number
  paid:     number
  reversed: number
  voided:   number
}

interface StatusBreakdown {
  earned:   { count: number; total_cents: number }
  held:     { count: number; total_cents: number }
  approved: { count: number; total_cents: number }
  paid:     { count: number; total_cents: number }
  reversed: { count: number; total_cents: number }
  voided:   { count: number; total_cents: number }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build an empty StatusTotals (cents-only, for order mode). */
function emptyStatusTotals(): StatusTotals {
  return { earned: 0, held: 0, approved: 0, paid: 0, reversed: 0, voided: 0 }
}

/** Build an empty StatusBreakdown (count + cents, for consultant mode). */
function emptyStatusBreakdown(): StatusBreakdown {
  const make = () => ({ count: 0, total_cents: 0 })
  return {
    earned: make(), held: make(), approved: make(),
    paid: make(), reversed: make(), voided: make(),
  }
}

/** Map a raw commission_entries row to EntryDetail. */
function toEntryDetail(row: Record<string, unknown>): EntryDetail {
  return {
    commission_entry_id: row['id'] as string,
    unit_id:             row['unit_id'] as string,
    serial_number:       row['serial_number'] as string,
    sku:                 row['sku'] as string,
    product_name:        row['product_name'] as string,
    retail_price_cents:  row['retail_price_cents'] as number,
    commission_cents:    row['commission_cents'] as number,
    status:              row['status'] as string,
    hold_reason:         row['hold_reason'] as string | null,
    created_at:          row['created_at'] as string,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('commission-summary', req)
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

    const { authorized, denied } = verifyRole(user, ALLOWED_ROLES, req)
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

    const hasOrder      = !!body.order_id
    const hasConsultant = !!body.consultant_id

    if (!hasOrder && !hasConsultant) {
      return jsonError(req, 'Provide either order_id or consultant_id', 400)
    }
    if (hasOrder && hasConsultant) {
      return jsonError(req, 'Provide either order_id or consultant_id — not both', 400)
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

    if (hasOrder && !uuidPattern.test(body.order_id!)) {
      return jsonError(req, 'order_id must be a valid UUID v4', 400)
    }
    if (hasConsultant && !uuidPattern.test(body.consultant_id!)) {
      return jsonError(req, 'consultant_id must be a valid UUID v4', 400)
    }
    if (body.from_date && !isoDatePattern.test(body.from_date)) {
      return jsonError(req, 'from_date must be an ISO 8601 date string (YYYY-MM-DD)', 400)
    }
    if (body.to_date && !isoDatePattern.test(body.to_date)) {
      return jsonError(req, 'to_date must be an ISO 8601 date string (YYYY-MM-DD)', 400)
    }
    if (body.from_date && body.to_date && body.from_date > body.to_date) {
      return jsonError(req, 'from_date must be on or before to_date', 400)
    }

    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(authorized.role)
    const admin   = createAdminClient()

    // ── Step 6: Route to query mode ───────────────────────────────────────────

    if (hasOrder) {
      return await handleOrderMode(req, body.order_id!, isAdmin, authorized, admin, authedLog)
    } else {
      return await handleConsultantMode(
        req, body.consultant_id!, body.from_date ?? null, body.to_date ?? null,
        isAdmin, authorized, admin, authedLog,
      )
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})

// ─── Mode: order ─────────────────────────────────────────────────────────────

async function handleOrderMode(
  req: Request,
  orderId: string,
  isAdmin: boolean,
  authorized: { id: string; role: string },
  admin: ReturnType<typeof createAdminClient>,
  log: { info: (m: string, c?: Record<string, unknown>) => void; warn: (m: string, c?: Record<string, unknown>) => void; error: (m: string, c?: Record<string, unknown>) => void },
): Promise<Response> {
  // Fetch order header and commission entries in parallel.
  const [orderResult, entriesResult] = await Promise.all([
    admin
      .from('orders')
      .select('id, order_number, status, consultant_id')
      .eq('id', orderId)
      .single(),

    admin
      .from('commission_entries')
      .select(`
        id, unit_id, serial_number, sku, product_name,
        retail_price_cents, commission_cents, commission_tier,
        commission_rate, status, hold_reason, consultant_name,
        created_at
      `)
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),
  ])

  if (orderResult.error !== null) {
    if (orderResult.error.code === 'PGRST116') {
      return jsonError(req, `Order not found: ${orderId}`, 404)
    }
    log.error('DB error fetching order', { code: orderResult.error.code })
    return jsonError(req, 'Internal server error', 500)
  }

  const order = orderResult.data

  // Ownership check: consultants may only view orders attributed to them.
  if (!isAdmin && order.consultant_id !== authorized.id) {
    // Fetch this consultant's profile id from their auth user id.
    const { data: profile } = await admin
      .from('consultant_profiles')
      .select('id')
      .eq('auth_user_id', authorized.id)
      .single()

    if (profile === null || order.consultant_id !== profile.id) {
      log.warn('Order ownership check failed', { order_id: orderId })
      return jsonError(req, 'You are not authorized to view commissions for this order', 403)
    }
  }

  const entries = (entriesResult.data ?? []) as Record<string, unknown>[]

  log.info('Order commission summary fetched', {
    order_number: order.order_number,
    entry_count:  entries.length,
  })

  // Aggregate totals.
  const byStatus = emptyStatusTotals()
  let totalRetailCents = 0
  let totalCommissionCents = 0

  for (const e of entries) {
    const status = e['status'] as CommissionStatus
    if (status in byStatus) {
      byStatus[status] += e['commission_cents'] as number
    }
    totalRetailCents     += e['retail_price_cents'] as number
    totalCommissionCents += e['commission_cents'] as number
  }

  // Derive tier and rate from the first entry (all lines share the same
  // consultant and were created with the same tier/rate at sale time).
  const firstEntry = entries[0]

  return jsonResponse(req, {
    query_mode:       'order',
    order_id:         order.id,
    order_number:     order.order_number,
    order_status:     order.status,
    consultant_id:    order.consultant_id,
    consultant_name:  firstEntry ? firstEntry['consultant_name'] : null,
    commission_tier:  firstEntry ? firstEntry['commission_tier'] : null,
    effective_rate:   firstEntry ? Number(firstEntry['commission_rate']) : null,
    entries:          entries.map(toEntryDetail),
    totals: {
      entry_count:             entries.length,
      total_retail_cents:      totalRetailCents,
      total_commission_cents:  totalCommissionCents,
      by_status:               byStatus,
    },
  })
}

// ─── Mode: consultant ─────────────────────────────────────────────────────────

async function handleConsultantMode(
  req: Request,
  consultantId: string,
  fromDate: string | null,
  toDate: string | null,
  isAdmin: boolean,
  authorized: { id: string; role: string },
  admin: ReturnType<typeof createAdminClient>,
  log: { info: (m: string, c?: Record<string, unknown>) => void; warn: (m: string, c?: Record<string, unknown>) => void; error: (m: string, c?: Record<string, unknown>) => void },
): Promise<Response> {
  // Fetch consultant profile and commission entries in parallel.
  const entriesQuery = admin
    .from('commission_entries')
    .select(`
      id, unit_id, serial_number, sku, product_name,
      retail_price_cents, commission_cents, status,
      hold_reason, created_at
    `)
    .eq('consultant_id', consultantId)
    .order('created_at', { ascending: false })
    .limit(CONSULTANT_ENTRY_LIMIT)

  if (fromDate) {
    entriesQuery.gte('created_at', `${fromDate}T00:00:00Z`)
  }
  if (toDate) {
    entriesQuery.lte('created_at', `${toDate}T23:59:59Z`)
  }

  const [profileResult, entriesResult] = await Promise.all([
    admin
      .from('consultant_profiles')
      .select(`
        id, auth_user_id, status, display_name, commission_tier,
        lifetime_gross_sales_cents, lifetime_commissions_cents, pending_payout_cents
      `)
      .eq('id', consultantId)
      .single(),

    entriesQuery,
  ])

  if (profileResult.error !== null) {
    if (profileResult.error.code === 'PGRST116') {
      return jsonError(req, `Consultant not found: ${consultantId}`, 404)
    }
    log.error('DB error fetching consultant profile', { code: profileResult.error.code })
    return jsonError(req, 'Internal server error', 500)
  }

  const profile = profileResult.data

  // Ownership check: a consultant may only view their own summary.
  if (!isAdmin && profile.auth_user_id !== authorized.id) {
    log.warn('Consultant ownership check failed', { consultant_id: consultantId })
    return jsonError(req, 'You are not authorized to view this consultant\'s commission summary', 403)
  }

  const entries = (entriesResult.data ?? []) as Record<string, unknown>[]

  log.info('Consultant commission summary fetched', {
    consultant_id: consultantId,
    entry_count:   entries.length,
    from_date:     fromDate,
    to_date:       toDate,
  })

  // Aggregate by status.
  const breakdown = emptyStatusBreakdown()

  for (const e of entries) {
    const status = e['status'] as CommissionStatus
    if (status in breakdown) {
      breakdown[status].count       += 1
      breakdown[status].total_cents += e['commission_cents'] as number
    }
  }

  return jsonResponse(req, {
    query_mode:     'consultant',
    consultant_id:  profile.id,
    display_name:   profile.display_name,
    commission_tier: profile.commission_tier,
    date_range: {
      from: fromDate,
      to:   toDate,
    },
    profile_totals: {
      lifetime_gross_sales_cents: profile.lifetime_gross_sales_cents,
      lifetime_commissions_cents: profile.lifetime_commissions_cents,
      pending_payout_cents:       profile.pending_payout_cents,
    },
    by_status:           breakdown,
    recent_entries:      entries.map(toEntryDetail),
    recent_entry_count:  entries.length,
  })
}
