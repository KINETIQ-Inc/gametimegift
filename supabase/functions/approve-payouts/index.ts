/**
 * GTG Edge Function — approve-payouts
 *
 * Admin batch approval of earned commission entries (4C-4).
 * Transitions specified commission_entries from 'earned' → 'approved',
 * clearing them for inclusion in the next payout run.
 *
 * ─── Commission approval lifecycle ────────────────────────────────────────────
 *
 *   earned   → Sale completed; commission calculated; awaiting admin review
 *   approved → Cleared by admin; eligible for payout disbursement
 *   paid     → Disbursed in a payout batch (future step)
 *
 * This endpoint handles the earned → approved transition only. 'held' entries
 * must be explicitly released before they can be approved. Entries at any other
 * status (paid, reversed, voided) are not eligible and will be rejected.
 *
 * ─── Eligibility pre-checks ───────────────────────────────────────────────────
 *
 * Before any update is applied, every entry and consultant is validated:
 *
 *   1. All commission_entry_ids must exist.
 *   2. All entries must have status = 'earned'.
 *   3. The consultant for each entry must have status = 'active'.
 *   4. The consultant for each entry must have tax_onboarding_complete = true.
 *
 * If any check fails, the entire batch is rejected — no partial approvals.
 * Error messages identify the specific entry IDs or consultant IDs that failed.
 *
 * ─── Concurrency ──────────────────────────────────────────────────────────────
 *
 * The UPDATE filters on status = 'earned', so entries that change state between
 * the pre-flight read and the update (e.g. placed on hold by another process)
 * are silently skipped. The response reports both approved_count and
 * skipped_count so the caller can detect and investigate any discrepancy.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Approving commissions is a financial action with payout consequences.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/approve-payouts
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "commission_entry_ids": ["<uuid>", "<uuid>", ...]   // 1–100 entries
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "approved_count": 5,
 *       "skipped_count":  0,
 *       "entries": [
 *         {
 *           "id":               "<uuid>",
 *           "consultant_id":    "<uuid>",
 *           "consultant_name":  "Jane Smith",
 *           "serial_number":    "GTG-CLC-2026-0001",
 *           "sku":              "APP-NIKE-JERSEY-M",
 *           "commission_cents": 499,
 *           "status":           "approved",
 *           "approved_at":      "2026-03-06T...",
 *           "approved_by":      "<uuid>"
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure, non-earned entries, or consultant eligibility failure
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  One or more commission_entry_ids not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ENTRIES      = 100

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  commission_entry_ids?: unknown
}

interface CommissionEntry {
  id:              string
  consultant_id:   string
  consultant_name: string
  serial_number:   string
  sku:             string
  product_name:    string
  commission_cents: number
  status:          string
}

interface ConsultantProfile {
  id:                     string
  display_name:           string
  status:                 string
  tax_onboarding_complete: boolean
}

interface ApprovedEntry {
  id:               string
  consultant_id:    string
  consultant_name:  string
  serial_number:    string
  sku:              string
  commission_cents: number
  status:           string
  approved_at:      string | null
  approved_by:      string | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('approve-payouts', req)
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

    if (!Array.isArray(body.commission_entry_ids)) {
      return jsonError(req, 'commission_entry_ids must be an array of UUIDs.', 400)
    }

    const ids = body.commission_entry_ids as unknown[]

    if (ids.length === 0) {
      return jsonError(req, 'commission_entry_ids must not be empty.', 400)
    }

    if (ids.length > MAX_ENTRIES) {
      return jsonError(
        req,
        `commission_entry_ids may contain at most ${MAX_ENTRIES} entries per request.`,
        400,
      )
    }

    // Validate each ID is a UUID string
    const invalidIds = ids.filter((id) => typeof id !== 'string' || !UUID_RE.test(id as string))
    if (invalidIds.length > 0) {
      return jsonError(
        req,
        `commission_entry_ids contains invalid values. All entries must be valid UUIDs. ` +
        `Invalid: ${invalidIds.slice(0, 5).join(', ')}${invalidIds.length > 5 ? ` (+${invalidIds.length - 5} more)` : ''}.`,
        400,
      )
    }

    // Detect intra-request duplicates
    const uniqueIds = [...new Set(ids as string[])]
    if (uniqueIds.length !== ids.length) {
      return jsonError(
        req,
        'commission_entry_ids contains duplicate entries. Each entry ID must appear at most once.',
        400,
      )
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch all commission entries ────────────────────────────────────

    authedLog.info('Fetching commission entries', { count: uniqueIds.length })

    const { data: entries, error: entriesError } = await admin
      .from('commission_entries')
      .select('id, consultant_id, consultant_name, serial_number, sku, product_name, commission_cents, status')
      .in('id', uniqueIds)

    if (entriesError !== null) {
      authedLog.error('Commission entries query failed', { error: entriesError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const found = (entries ?? []) as CommissionEntry[]

    // ── Step 7: Validate — all entries found ────────────────────────────────────

    if (found.length !== uniqueIds.length) {
      const foundIds = new Set(found.map((e) => e.id))
      const missing  = uniqueIds.filter((id) => !foundIds.has(id))
      authedLog.warn('Commission entries not found', { missing })
      return jsonError(
        req,
        `The following commission entry IDs were not found: ${missing.join(', ')}.`,
        404,
      )
    }

    // ── Step 8: Validate — all entries are 'earned' ─────────────────────────────

    const nonEarned = found.filter((e) => e.status !== 'earned')
    if (nonEarned.length > 0) {
      const detail = nonEarned
        .slice(0, 10)
        .map((e) => `${e.id} (${e.status})`)
        .join(', ')
      authedLog.warn('Non-earned entries in request', {
        count: nonEarned.length,
        statuses: [...new Set(nonEarned.map((e) => e.status))],
      })
      return jsonError(
        req,
        `Only 'earned' commission entries may be approved. ` +
        `The following entries are not in 'earned' status: ${detail}` +
        `${nonEarned.length > 10 ? ` (+${nonEarned.length - 10} more)` : ''}.`,
        400,
      )
    }

    // ── Step 9: Fetch and validate consultant eligibility ───────────────────────

    const consultantIds = [...new Set(found.map((e) => e.consultant_id))]

    const { data: consultants, error: consultantsError } = await admin
      .from('consultant_profiles')
      .select('id, display_name, status, tax_onboarding_complete')
      .in('id', consultantIds)

    if (consultantsError !== null) {
      authedLog.error('Consultant profiles query failed', { error: consultantsError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const consultantMap = new Map(
      ((consultants ?? []) as ConsultantProfile[]).map((c) => [c.id, c]),
    )

    // Inactive consultants — commissions cannot be approved while account is not active
    const inactiveConsultants = consultantIds
      .map((id) => consultantMap.get(id))
      .filter((c): c is ConsultantProfile => c !== undefined && c.status !== 'active')

    if (inactiveConsultants.length > 0) {
      const detail = inactiveConsultants
        .map((c) => `${c.id} (${c.display_name}, status=${c.status})`)
        .join(', ')
      authedLog.warn('Ineligible consultant status', {
        consultant_ids: inactiveConsultants.map((c) => c.id),
      })
      return jsonError(
        req,
        `Commissions cannot be approved for consultants whose status is not 'active'. ` +
        `Ineligible consultants: ${detail}.`,
        400,
      )
    }

    // Tax onboarding incomplete — payout cannot proceed without a valid tax record
    const taxIncomplete = consultantIds
      .map((id) => consultantMap.get(id))
      .filter((c): c is ConsultantProfile => c !== undefined && !c.tax_onboarding_complete)

    if (taxIncomplete.length > 0) {
      const detail = taxIncomplete.map((c) => `${c.id} (${c.display_name})`).join(', ')
      authedLog.warn('Tax onboarding incomplete', {
        consultant_ids: taxIncomplete.map((c) => c.id),
      })
      return jsonError(
        req,
        'Commissions cannot be approved until tax onboarding is complete. ' +
        `The following consultants have not completed tax onboarding: ${detail}.`,
        400,
      )
    }

    // ── Step 10: Apply approval ─────────────────────────────────────────────────

    const approvedAt = new Date().toISOString()

    authedLog.info('Approving commission entries', {
      count:           uniqueIds.length,
      consultant_count: consultantIds.length,
    })

    const { data: approvedRows, error: updateError } = await admin
      .from('commission_entries')
      .update({
        status:      'approved',
        approved_at: approvedAt,
        approved_by: authorized.id,
      })
      .in('id', uniqueIds)
      .eq('status', 'earned')           // guard: skip any that changed state since pre-flight
      .select(
        'id, consultant_id, consultant_name, serial_number, sku, ' +
        'commission_cents, status, approved_at, approved_by',
      )

    if (updateError !== null) {
      authedLog.error('Approval update failed', { error: updateError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const approved      = (approvedRows ?? []) as ApprovedEntry[]
    const approvedCount = approved.length
    const skippedCount  = uniqueIds.length - approvedCount

    if (skippedCount > 0) {
      const approvedIds = new Set(approved.map((e) => e.id))
      const skipped     = uniqueIds.filter((id) => !approvedIds.has(id))
      authedLog.warn('Some entries skipped due to concurrent status change', { skipped })
    }

    authedLog.info('Payout approval complete', {
      approved_count: approvedCount,
      skipped_count:  skippedCount,
    })

    return jsonResponse(req, {
      approved_count: approvedCount,
      skipped_count:  skippedCount,
      entries:        approved,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
