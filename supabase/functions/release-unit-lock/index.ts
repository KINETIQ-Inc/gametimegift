/**
 * GTG Edge Function — release-unit-lock
 *
 * Releases a fraud lock on a serialized unit after validating that the
 * requesting authority is permitted to lift the lock. Calls the
 * release_unit_lock() DB function which atomically:
 *   1. Validates release_authority against the lock's lock_authority
 *   2. Deactivates the lock_records row (is_active → false)
 *   3. Restores serialized_units.status to the pre-lock value
 *   4. Clears the fraud lock fields (fraud_locked_at/by/reason → null)
 *   5. Appends a 'fraud_released' inventory_ledger_entries row
 *
 * ─── Authority rules ──────────────────────────────────────────────────────────
 *
 *   lock_authority = 'system'    →  release_authority must be 'gtg_admin'
 *   lock_authority = 'gtg_admin' →  release_authority must be 'gtg_admin'
 *   lock_authority = 'clc'       →  release_authority: 'clc' or 'gtg_admin'
 *   lock_authority = 'army'      →  release_authority: 'army' or 'gtg_admin'
 *
 *   release_reference_id is required when release_authority is 'clc' or 'army'.
 *
 * ─── Fraud flag lifecycle ─────────────────────────────────────────────────────
 *
 * Releasing a lock does NOT close the associated fraud_flag. Investigation
 * workflow (open → under_review → confirmed/dismissed) continues independently.
 * An investigator may release the unit while the investigation is in progress.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Lock release is a compliance-critical write. The release_authority in the
 * request body is the institutional authority being exercised (not the JWT role).
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/release-unit-lock
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   {
 *     "lock_record_id":        "<uuid>",        // required
 *     "release_reason":        "Investigation dismissed — false positive",
 *     "release_authority":     "gtg_admin",     // gtg_admin | clc | army
 *     "release_reference_id":  "CLC-2026-0042"  // required for clc/army authority
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "lock_record_id":        "<uuid>",
 *       "unit_id":               "<uuid>",
 *       "serial_number":         "GTG-ABC123",
 *       "restored_status":       "available",
 *       "ledger_entry_id":       "<uuid>",
 *       "release_authority":     "gtg_admin",
 *       "release_reference_id":  null
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (authority mismatch, missing reference, already released,
 *        wrong scope, unit/lock out of sync)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  lock_record not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_RELEASE_AUTHORITIES = new Set(['gtg_admin', 'clc', 'army'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  lock_record_id:        string
  release_reason:        string
  release_authority:     string
  release_reference_id?: string
}

interface LockRecord {
  id:             string
  scope:          string
  target_id:      string
  target_label:   string
  lock_authority: string
  is_active:      boolean
  fraud_flag_id:  string | null
}

interface ReleaseRow {
  unit_id:         string
  restored_status: string
  ledger_entry_id: string
}

interface ResponsePayload {
  lock_record_id:       string
  unit_id:              string
  serial_number:        string
  restored_status:      string
  ledger_entry_id:      string
  release_authority:    string
  release_reference_id: string | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('release-unit-lock', req)
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

    if (!body.lock_record_id || !UUID_RE.test(body.lock_record_id)) {
      return jsonError(req, 'lock_record_id must be a valid UUID.', 400)
    }

    if (!body.release_reason || typeof body.release_reason !== 'string' || body.release_reason.trim() === '') {
      return jsonError(req, 'release_reason is required.', 400)
    }

    if (!body.release_authority || !VALID_RELEASE_AUTHORITIES.has(body.release_authority)) {
      return jsonError(
        req,
        `release_authority must be one of: ${[...VALID_RELEASE_AUTHORITIES].join(', ')}. ` +
        `'system' is not a valid release authority — locks applied by the system are released by 'gtg_admin'.`,
        400,
      )
    }

    // Licensor releases require a reference document.
    if (
      (body.release_authority === 'clc' || body.release_authority === 'army') &&
      (!body.release_reference_id || body.release_reference_id.trim() === '')
    ) {
      return jsonError(
        req,
        `release_reference_id is required when release_authority is '${body.release_authority}'. ` +
        `Provide the licensor approval document or correspondence reference.`,
        400,
      )
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch lock record for pre-flight context ────────────────────────
    // Fetch before calling the DB function to surface actionable 404 and scope
    // errors here rather than relying on generic DB exception messages.
    // The DB function re-reads under FOR UPDATE, so no TOCTOU concern.

    const { data: lockData, error: lockError } = await admin
      .from('lock_records')
      .select('id, scope, target_id, target_label, lock_authority, is_active, fraud_flag_id')
      .eq('id', body.lock_record_id)
      .single()

    if (lockError !== null) {
      if (lockError.code === 'PGRST116') {
        return jsonError(req, `lock_record '${body.lock_record_id}' not found.`, 404)
      }
      authedLog.error('DB error fetching lock record', { code: lockError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const lock = lockData as LockRecord

    if (lock.scope !== 'unit') {
      return jsonError(
        req,
        `lock_record has scope '${lock.scope}'. ` +
        `This endpoint handles unit-scope locks only.`,
        400,
      )
    }

    if (!lock.is_active) {
      return jsonError(
        req,
        `lock_record '${body.lock_record_id}' is already released (is_active = false). ` +
        `Each lock may only be released once.`,
        400,
      )
    }

    // ── Step 7: Call release_unit_lock DB function ──────────────────────────────

    authedLog.info('Releasing unit lock', {
      lock_record_id:      body.lock_record_id,
      lock_authority:      lock.lock_authority,
      release_authority:   body.release_authority,
      target_label:        lock.target_label,
      fraud_flag_id:       lock.fraud_flag_id,
    })

    const { data: releaseRows, error: releaseError } = await admin.rpc('release_unit_lock', {
      p_lock_record_id:       body.lock_record_id,
      p_released_by:          authorized.id,
      p_release_reason:       body.release_reason,
      p_release_authority:    body.release_authority,
      p_release_reference_id: body.release_reference_id ?? null,
    })

    if (releaseError !== null) {
      const gtgMatch = releaseError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('release_unit_lock failed', {
        lock_record_id: body.lock_record_id,
        error:          releaseError.message,
      })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Failed to release unit lock.', 400)
    }

    const result = (releaseRows as ReleaseRow[])[0]!

    authedLog.info('Unit lock released', {
      lock_record_id:   body.lock_record_id,
      unit_id:          result.unit_id,
      restored_status:  result.restored_status,
      ledger_entry_id:  result.ledger_entry_id,
      release_authority: body.release_authority,
    })

    return jsonResponse(req, {
      lock_record_id:       body.lock_record_id,
      unit_id:              result.unit_id,
      serial_number:        lock.target_label,  // denormalized on lock_records
      restored_status:      result.restored_status,
      ledger_entry_id:      result.ledger_entry_id,
      release_authority:    body.release_authority,
      release_reference_id: body.release_reference_id ?? null,
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
