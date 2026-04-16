/**
 * GTG Edge Function — get-consultant-pending-payouts
 *
 * Pending payouts dashboard widget for the consultant portal (6B-3).
 * Returns the consultant's current outstanding payout balance and the
 * individual commission entries that make it up.
 *
 * ─── What "pending" means ─────────────────────────────────────────────────────
 *
 * A commission entry is pending when its status = 'earned' — the commission
 * has been recorded and credited to the consultant's running totals but has
 * not yet been included in a payout batch (status = 'paid') or reversed
 * (status = 'voided').
 *
 * consultant_profiles.pending_payout_cents is the pre-computed sum of all
 * earned-status commission_entries for the consultant. It is incremented
 * atomically with every sale (via credit_consultant_sale) and decremented
 * when a payout batch is processed. The value here is authoritative.
 *
 * ─── Response shape ───────────────────────────────────────────────────────────
 *
 *   pending_payout_cents   Headline balance — the amount the consultant is
 *                          owed. Sourced from consultant_profiles; always
 *                          consistent with the entries list.
 *
 *   entries_count          Count of unpaid commission entries. Convenience
 *                          field matching entries.length.
 *
 *   entries                All commission_entries with status = 'earned' for
 *                          this consultant, ordered oldest-first so the
 *                          consultant can see which sales have been waiting
 *                          longest. commission_entries denormalises product
 *                          and order fields so no join is required.
 *
 * ─── No period filter ─────────────────────────────────────────────────────────
 *
 * Unlike 6B-1 and 6B-2, this endpoint has no date range parameter. Pending
 * payouts is a current-balance view: the full set of everything owed, not a
 * slice of history. A period filter would produce a misleading sub-total.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 *   consultant    Retrieves their own pending payouts. No consultant_id in body.
 *   admin         May retrieve any consultant's data by passing consultant_id.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-consultant-pending-payouts
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   Consultant (own dashboard):
 *   {}
 *
 *   Admin (any consultant):
 *   { "consultant_id": "<uuid>" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "consultant_id":        "<uuid>",
 *       "display_name":         "Jane S.",
 *       "pending_payout_cents": 5999,
 *       "entries_count":        1,
 *       "entries": [
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
 *           "earned_at":          "2026-03-05T14:22:11Z"
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (invalid consultant_id format)
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id?: unknown
}

interface ConsultantRow {
  id:                   string
  display_name:         string
  pending_payout_cents: number
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
  created_at:         string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('get-consultant-pending-payouts', req)
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
      // Empty body — valid for consultant retrieving own data.
    }

    // consultant_id only honoured for admins.
    if (body.consultant_id !== undefined && !isAdmin) {
      body = {}
    }

    if (body.consultant_id !== undefined && body.consultant_id !== null) {
      if (typeof body.consultant_id !== 'string' || !UUID_RE.test(body.consultant_id)) {
        return jsonError(req, 'consultant_id must be a valid UUID when provided.', 400)
      }
    }

    // ── Step 6: Resolve consultant profile ──────────────────────────────────

    const admin = createAdminClient()

    let profileQuery = admin
      .from('consultant_profiles')
      .select('id, display_name, pending_payout_cents')

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

    // ── Step 7: Fetch all earned (unpaid) commission entries ─────────────────
    // Ordered oldest-first: the consultant can see which sales have been
    // waiting longest for payment. No limit — this is a complete balance view.

    const { data: entriesData, error: entriesError } = await admin
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
        created_at
      `)
      .eq('consultant_id', profile.id)
      .eq('status', 'earned')
      .order('created_at', { ascending: true })

    if (entriesError !== null) {
      authedLog.error('Pending entries query failed', { error: entriesError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const entries = ((entriesData ?? []) as CommissionEntryRow[]).map((e) => ({
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
      earned_at:          e.created_at,
    }))

    authedLog.info('Pending payouts fetched', {
      consultant_id:        profile.id,
      pending_payout_cents: profile.pending_payout_cents,
      entries_count:        entries.length,
    })

    return jsonResponse(req, {
      consultant_id:        profile.id,
      display_name:         profile.display_name,
      pending_payout_cents: profile.pending_payout_cents,
      entries_count:        entries.length,
      entries,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
