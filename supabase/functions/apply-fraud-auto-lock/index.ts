/**
 * GTG Edge Function — apply-fraud-auto-lock
 *
 * Enforces the severity-based auto-lock policy for an existing fraud_flag.
 * If the flag's severity is 'high' or 'critical' and the unit is not already
 * locked, this function applies a system-authority lock atomically via the
 * apply_fraud_auto_lock() DB function.
 *
 * ─── Auto-lock policy ─────────────────────────────────────────────────────────
 *
 *   severity = 'low'      → no auto-lock (informational, investigation queue)
 *   severity = 'medium'   → no auto-lock (7-day SLA, no operational restriction)
 *   severity = 'high'     → auto-lock (72-hour SLA; unit locked under system authority)
 *   severity = 'critical' → auto-lock (24-hour SLA; unit locked under system authority)
 *
 * ─── When to call this function ──────────────────────────────────────────────
 *
 * Most detection paths that produce high/critical flags inline the auto-lock
 * step at flag creation (e.g. flag_duplicate_serial). This Edge Function handles
 * the cases where that is not possible or where the situation has changed:
 *
 *   1. Unit was already fraud_locked when the flag was created — auto-lock was
 *      skipped. Once the prior lock is released, call this function to re-apply.
 *
 *   2. Flag severity was escalated after creation (e.g. from medium → high by
 *      an investigator). Update the flag severity, then call this function.
 *
 *   3. A new signal detection path creates the flag without inlining the lock.
 *      Call this function as the next step in the pipeline.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * If fraud_flag.auto_locked = true already, the existing lock_record_id is
 * returned with was_locked = false. Safe to call multiple times.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Applying a unit lock is a compliance-critical write operation.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/apply-fraud-auto-lock
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "fraud_flag_id": "<uuid>" }
 *
 * ─── Response: lock applied ───────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "fraud_flag_id":  "<uuid>",
 *       "lock_record_id": "<uuid>",
 *       "was_locked":     true,
 *       "severity":       "high",
 *       "flag_status":    "open",
 *       "unit_id":        "<uuid>"
 *     }
 *   }
 *
 * ─── Response: already locked (idempotent) ───────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "fraud_flag_id":  "<uuid>",
 *       "lock_record_id": "<uuid>",   // the existing lock
 *       "was_locked":     false,
 *       ...
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (invalid UUID, low/medium severity, terminal flag, unit already locked)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  fraud_flag_id: string
}

interface FlagRecord {
  id:          string
  unit_id:     string
  severity:    string
  status:      string
  auto_locked: boolean
  auto_lock_id: string | null
}

interface ResponsePayload {
  fraud_flag_id:  string
  lock_record_id: string | null
  was_locked:     boolean
  severity:       string
  flag_status:    string
  unit_id:        string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('apply-fraud-auto-lock', req)
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

    const admin = createAdminClient()

    // ── Step 6: Fetch fraud flag for pre-flight context ─────────────────────────
    // Fetch before the DB function call so we can surface a clear error and
    // include flag metadata in the response without relying on DB error messages.
    //
    // The DB function re-reads the flag inside its transaction (SECURITY DEFINER),
    // so there is no TOCTOU issue — the pre-flight here is for caller feedback only.

    const { data: flagData, error: flagError } = await admin
      .from('fraud_flags')
      .select('id, unit_id, severity, status, auto_locked, auto_lock_id')
      .eq('id', body.fraud_flag_id)
      .single()

    if (flagError !== null) {
      if (flagError.code === 'PGRST116') {
        return jsonError(req, `fraud_flag '${body.fraud_flag_id}' not found.`, 404)
      }
      authedLog.error('DB error fetching fraud flag', { code: flagError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const flag = flagData as FlagRecord

    // Surface policy rejections before hitting the DB function, for clearer errors.
    if (flag.severity !== 'high' && flag.severity !== 'critical') {
      return jsonError(
        req,
        `fraud_flag has severity '${flag.severity}' — auto-lock applies only to ` +
        `'high' and 'critical' flags. Low and medium flags are informational.`,
        400,
      )
    }

    if (flag.status === 'confirmed' || flag.status === 'dismissed') {
      return jsonError(
        req,
        `fraud_flag has status '${flag.status}' and is terminal. ` +
        `Auto-lock applies only to open, under_review, and escalated flags.`,
        400,
      )
    }

    // ── Step 7: Apply auto-lock ─────────────────────────────────────────────────

    authedLog.info('Applying fraud auto-lock', {
      fraud_flag_id: body.fraud_flag_id,
      unit_id:       flag.unit_id,
      severity:      flag.severity,
      flag_status:   flag.status,
      already_locked: flag.auto_locked,
    })

    const { data: lockRows, error: lockError } = await admin.rpc('apply_fraud_auto_lock', {
      p_fraud_flag_id: body.fraud_flag_id,
      p_applied_by:    authorized.id,
    })

    if (lockError !== null) {
      const gtgMatch = lockError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('apply_fraud_auto_lock failed', {
        fraud_flag_id: body.fraud_flag_id,
        error:         lockError.message,
      })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Failed to apply fraud auto-lock.', 400)
    }

    const lock = (lockRows as Array<{ lock_record_id: string | null; was_locked: boolean }>)[0]!

    if (lock.was_locked) {
      authedLog.info('Auto-lock applied', {
        fraud_flag_id:  body.fraud_flag_id,
        lock_record_id: lock.lock_record_id,
        unit_id:        flag.unit_id,
      })
    } else {
      authedLog.info('Auto-lock already applied — idempotent', {
        fraud_flag_id:  body.fraud_flag_id,
        lock_record_id: lock.lock_record_id,
        unit_id:        flag.unit_id,
      })
    }

    return jsonResponse(req, {
      fraud_flag_id:  body.fraud_flag_id,
      lock_record_id: lock.lock_record_id,
      was_locked:     lock.was_locked,
      severity:       flag.severity,
      flag_status:    flag.status,
      unit_id:        flag.unit_id,
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
