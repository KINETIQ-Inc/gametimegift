/**
 * GTG Edge Function — escalate-fraud-flag
 *
 * Escalates a fraud flag investigation to 'escalated' status (4E-3).
 * Records the escalation reason and optionally reassigns the flag to a
 * senior investigator or licensor liaison.
 *
 * ─── What escalation means ────────────────────────────────────────────────────
 *
 * Escalation signals that the investigation requires elevated authority —
 * a senior investigator, legal review, or direct licensor coordination.
 * It does not apply or release any lock; unit status is unchanged.
 *
 * Typical escalation triggers:
 *   - Initial investigation found credible fraud evidence requiring senior sign-off
 *   - The signal source is a licensor_report requiring CLC or Army coordination
 *   - Conflicting evidence or legal exposure requires outside review
 *   - The SLA for the current assignee has elapsed without resolution
 *
 * ─── Eligible flags ───────────────────────────────────────────────────────────
 *
 * The flag must be in status 'open' or 'under_review'. Flags already at
 * 'escalated', 'confirmed', or 'dismissed' are not eligible.
 *
 * ─── Assignment ───────────────────────────────────────────────────────────────
 *
 * assign_to is optional. When provided, the flag is reassigned to that
 * auth.users.id as part of the escalation, with assigned_at updated to now.
 * When omitted, the current assignee (if any) is preserved unchanged.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/escalate-fraud-flag
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "fraud_flag_id":     "<uuid>",
 *     "escalation_reason": "Initial review confirmed hologram mismatch. Escalating to CLC liaison for licensor-level verification.",
 *     "assign_to":         "<uuid>"   // optional — auth.users.id of senior investigator
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "fraud_flag_id":     "<uuid>",
 *       "unit_id":           "<uuid>",
 *       "serial_number":     "GTG-CLC-2026-0001",
 *       "source":            "hologram_scan_fail",
 *       "severity":          "high",
 *       "previous_status":   "under_review",
 *       "status":            "escalated",
 *       "escalation_reason": "Initial review confirmed hologram mismatch...",
 *       "assigned_to":       "<uuid>",
 *       "assigned_at":       "2026-03-06T...",
 *       "updated_at":        "2026-03-06T..."
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or flag not in escalatable status (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Fraud flag not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Statuses from which a flag may be escalated
const ESCALATABLE_STATUSES = new Set(['open', 'under_review'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  fraud_flag_id?:     string
  escalation_reason?: string
  assign_to?:         string
}

interface FraudFlag {
  id:            string
  unit_id:       string
  serial_number: string
  source:        string
  severity:      string
  status:        string
  assigned_to:   string | null
  assigned_at:   string | null
}

interface UpdatePayload {
  status:            string
  escalation_reason: string
  assigned_to?:      string
  assigned_at?:      string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('escalate-fraud-flag', req)
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

    if (!body.fraud_flag_id || !UUID_RE.test(body.fraud_flag_id)) {
      return jsonError(req, 'fraud_flag_id must be a valid UUID.', 400)
    }

    if (!body.escalation_reason || typeof body.escalation_reason !== 'string' ||
        body.escalation_reason.trim().length === 0) {
      return jsonError(
        req,
        'escalation_reason is required. Document why this investigation is being ' +
        'escalated (visible in the audit trail).',
        400,
      )
    }

    if (body.assign_to !== undefined && !UUID_RE.test(body.assign_to)) {
      return jsonError(req, 'assign_to must be a valid UUID (auth.users.id).', 400)
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch and validate the fraud flag ───────────────────────────────

    authedLog.info('Fetching fraud flag', { fraud_flag_id: body.fraud_flag_id })

    const { data: flagData, error: flagError } = await admin
      .from('fraud_flags')
      .select('id, unit_id, serial_number, source, severity, status, assigned_to, assigned_at')
      .eq('id', body.fraud_flag_id)
      .single()

    if (flagError !== null || flagData === null) {
      authedLog.warn('Fraud flag not found', { fraud_flag_id: body.fraud_flag_id })
      return jsonError(req, `Fraud flag '${body.fraud_flag_id}' not found.`, 404)
    }

    const flag = flagData as FraudFlag

    if (!ESCALATABLE_STATUSES.has(flag.status)) {
      const isTerminal = flag.status === 'confirmed' || flag.status === 'dismissed'
      authedLog.warn('Flag not in escalatable status', {
        fraud_flag_id: flag.id,
        status:        flag.status,
      })
      return jsonError(
        req,
        `Fraud flag '${flag.id}' has status '${flag.status}' and cannot be escalated. ` +
        (isTerminal
          ? 'The investigation is already closed. Use view-unit-history to inspect the resolution.'
          : "Only flags with status 'open' or 'under_review' may be escalated."),
        400,
      )
    }

    // ── Step 7: Verify assign_to user exists (if provided) ──────────────────────
    //
    // A pre-flight check against auth.users prevents silent assignment to a
    // non-existent or deleted account, which would leave the flag unworkable.

    if (body.assign_to !== undefined) {
      const { data: assignee, error: assigneeError } = await admin.auth.admin.getUserById(
        body.assign_to,
      )
      if (assigneeError !== null || assignee.user === null) {
        authedLog.warn('Assignee not found', { assign_to: body.assign_to })
        return jsonError(
          req,
          `User '${body.assign_to}' not found in auth.users. ` +
          'assign_to must be a valid auth.users.id of an existing user.',
          404,
        )
      }
    }

    // ── Step 8: Build update payload ────────────────────────────────────────────

    const escalatedAt = new Date().toISOString()

    const updatePayload: UpdatePayload = {
      status:            'escalated',
      escalation_reason: body.escalation_reason.trim(),
    }

    if (body.assign_to !== undefined) {
      updatePayload.assigned_to  = body.assign_to
      updatePayload.assigned_at  = escalatedAt
    }

    // ── Step 9: Apply escalation ────────────────────────────────────────────────

    authedLog.info('Escalating fraud flag', {
      fraud_flag_id:   flag.id,
      previous_status: flag.status,
      reassigning:     body.assign_to !== undefined,
    })

    const { data: updated, error: updateError } = await admin
      .from('fraud_flags')
      .update(updatePayload)
      .eq('id', flag.id)
      .select('assigned_to, assigned_at, updated_at')
      .single()

    if (updateError !== null) {
      authedLog.error('Escalation update failed', { error: updateError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('Fraud flag escalated', {
      fraud_flag_id:   flag.id,
      previous_status: flag.status,
      assigned_to:     updated.assigned_to,
    })

    return jsonResponse(req, {
      fraud_flag_id:     flag.id,
      unit_id:           flag.unit_id,
      serial_number:     flag.serial_number,
      source:            flag.source,
      severity:          flag.severity,
      previous_status:   flag.status,
      status:            'escalated',
      escalation_reason: updatePayload.escalation_reason,
      assigned_to:       updated.assigned_to,
      assigned_at:       updated.assigned_at,
      updated_at:        updated.updated_at,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
