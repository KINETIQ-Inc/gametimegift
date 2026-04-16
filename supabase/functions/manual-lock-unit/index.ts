/**
 * GTG Edge Function — manual-lock-unit
 *
 * Admin manual unit lock and unlock (4B-4).
 * Unified endpoint for direct admin control of unit fraud-lock status,
 * independent of the automated fraud-flag pipeline (3D-1 through 3D-4).
 *
 * ─── Actions ──────────────────────────────────────────────────────────────────
 *
 *   action = "lock"    Fraud-locks a unit under admin authority.
 *                      Calls lock_unit — atomically updates unit status to
 *                      'fraud_locked', creates a lock_records row, and appends
 *                      an inventory_ledger_entries row in one transaction.
 *
 *   action = "unlock"  Releases an existing unit lock under gtg_admin authority.
 *                      Calls release_unit_lock — atomically restores the unit
 *                      to its pre-lock status, closes the lock_records row, and
 *                      appends a 'fraud_released' ledger entry.
 *
 * ─── Relationship to the fraud pipeline ──────────────────────────────────────
 *
 * The fraud pipeline (3D) creates locks tied to fraud_flags and supports
 * multi-authority releases. This endpoint is the admin dashboard's direct
 * control — no fraud flag is required to lock, and release always uses
 * gtg_admin authority (the highest internal authority).
 *
 * Use the fraud pipeline when:
 *   - A specific fraud signal source must be recorded (hologram failure,
 *     duplicate serial, licensor report, etc.)
 *   - A high/critical severity flag must auto-lock and trigger an SLA
 *
 * Use this endpoint when:
 *   - An admin wants to immediately halt a unit pending any investigation
 *   - An admin wants to release a lock without going through the flag workflow
 *
 * ─── Lock authority ───────────────────────────────────────────────────────────
 *
 * lock_authority defaults to 'gtg_admin'. For licensor-directed locks applied
 * via this endpoint, 'clc' or 'army' may be specified — which then requires
 * licensor_reference_id (the licensor's document reference).
 *
 * The release authority for unlock is always 'gtg_admin'. gtg_admin can
 * release locks regardless of which authority originally applied them.
 *
 * ─── Lockable statuses ────────────────────────────────────────────────────────
 *
 * A unit may be locked from: available, reserved, sold, returned.
 * fraud_locked and voided units cannot be locked (already locked / terminal).
 * The DB function enforces this — a status violation returns a [GTG] error.
 *
 * ─── Unlock pre-flight ────────────────────────────────────────────────────────
 *
 * Before calling the DB function, the lock_record is fetched to:
 *   - Confirm it exists (404 if not)
 *   - Confirm scope = 'unit' (400 if wrong scope)
 *   - Confirm is_active = true (400 if already released)
 *   - Capture serial_number (target_label) for the response
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Manual lock/unlock is an enforcement action with compliance consequences.
 *
 * ─── Request — lock ───────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/manual-lock-unit
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "action":                "lock",
 *     "unit_id":               "<uuid>",
 *     "reason":                "Admin hold — suspected duplicate serial pending investigation.",
 *     "lock_authority":        "gtg_admin",    // optional; default gtg_admin
 *     "licensor_reference_id": "CLC-REF-042"  // required if lock_authority = clc or army
 *   }
 *
 * ─── Request — unlock ─────────────────────────────────────────────────────────
 *
 *   {
 *     "action":                "unlock",
 *     "lock_record_id":        "<uuid>",
 *     "release_reason":        "Investigation complete — unit cleared. No fraud confirmed.",
 *     "release_reference_id":  "CLC-CLEAR-007"  // optional; document licensor clearance
 *   }
 *
 * ─── Response — lock ──────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "action":           "lock",
 *       "unit_id":          "<uuid>",
 *       "serial_number":    "GTG-CLC-2026-0001",
 *       "lock_record_id":   "<uuid>",
 *       "ledger_entry_id":  "<uuid>",
 *       "lock_authority":   "gtg_admin"
 *     }
 *   }
 *
 * ─── Response — unlock ────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "action":               "unlock",
 *       "unit_id":              "<uuid>",
 *       "serial_number":        "GTG-CLC-2026-0001",
 *       "lock_record_id":       "<uuid>",
 *       "restored_status":      "available",
 *       "ledger_entry_id":      "<uuid>"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or business rule violation (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Unit or lock_record not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Authorities valid for a manual lock; 'system' is automated-only
const VALID_LOCK_AUTHORITIES   = new Set(['gtg_admin', 'clc', 'army'])
// Licensor authorities that require an external reference on the lock
const LICENSOR_LOCK_AUTHORITIES = new Set(['clc', 'army'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  action: string

  // Lock fields
  unit_id?:               string
  reason?:                string
  lock_authority?:        string
  licensor_reference_id?: string

  // Unlock fields
  lock_record_id?:       string
  release_reason?:       string
  release_reference_id?: string
}

interface LockRow {
  lock_record_id:  string
  ledger_entry_id: string
}

interface ReleaseRow {
  unit_id:         string
  restored_status: string
  ledger_entry_id: string
}

interface LockRecord {
  id:             string
  scope:          string
  target_id:      string
  target_label:   string   // serial_number for unit scope
  lock_authority: string
  is_active:      boolean
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('manual-lock-unit', req)
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

    // ── Step 5: Parse request body ──────────────────────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.action || (body.action !== 'lock' && body.action !== 'unlock')) {
      return jsonError(req, "action must be 'lock' or 'unlock'.", 400)
    }

    const admin = createAdminClient()

    // ══════════════════════════════════════════════════════════════════════════
    // LOCK branch
    // ══════════════════════════════════════════════════════════════════════════

    if (body.action === 'lock') {

      // ── Validate lock fields ──────────────────────────────────────────────────

      if (!body.unit_id || !UUID_RE.test(body.unit_id)) {
        return jsonError(req, 'unit_id must be a valid UUID.', 400)
      }

      if (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length === 0) {
        return jsonError(
          req,
          'reason is required for a manual lock. ' +
          'Document why this unit is being locked (visible in the audit trail).',
          400,
        )
      }

      const lockAuthority = body.lock_authority ?? 'gtg_admin'

      if (!VALID_LOCK_AUTHORITIES.has(lockAuthority)) {
        return jsonError(
          req,
          "lock_authority must be one of: 'gtg_admin', 'clc', 'army'. " +
          "The 'system' authority is reserved for automated fraud rules.",
          400,
        )
      }

      // licensor_reference_id is required for clc/army locks
      if (LICENSOR_LOCK_AUTHORITIES.has(lockAuthority)) {
        if (!body.licensor_reference_id ||
            typeof body.licensor_reference_id !== 'string' ||
            body.licensor_reference_id.trim().length === 0) {
          return jsonError(
            req,
            `licensor_reference_id is required when lock_authority is '${lockAuthority}'. ` +
            'Provide the external document reference from the licensor authorizing this lock.',
            400,
          )
        }
      }

      // ── Apply lock ────────────────────────────────────────────────────────────

      authedLog.info('Applying manual lock', {
        unit_id:        body.unit_id,
        lock_authority: lockAuthority,
      })

      const { data: rows, error: lockError } = await admin.rpc(
        'lock_unit',
        {
          p_unit_id:               body.unit_id,
          p_performed_by:          authorized.id,
          p_lock_reason:           body.reason.trim(),
          p_lock_authority:        lockAuthority,
          p_fraud_flag_id:         null,
          p_licensor_reference_id: body.licensor_reference_id?.trim() ?? null,
        },
      )

      if (lockError !== null) {
        const gtgMatch = lockError.message.match(/\[GTG\][^.]+\./)
        authedLog.error('lock_unit failed', { error: lockError.message })
        // Unit not found → 404; status violation → 400; anything else → 500
        if (lockError.message.includes('unit not found')) {
          return jsonError(req, gtgMatch ? gtgMatch[0] : `Unit '${body.unit_id}' not found.`, 404)
        }
        if (lockError.message.includes('cannot be fraud-locked')) {
          return jsonError(req, gtgMatch ? gtgMatch[0] : 'Unit cannot be locked from its current status.', 400)
        }
        return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
      }

      const lockRow = (rows as LockRow[])[0]

      // Fetch serial_number for the response (lock_unit does not return it directly)
      const { data: unitSnap } = await admin
        .from('serialized_units')
        .select('serial_number')
        .eq('id', body.unit_id)
        .single()

      authedLog.info('Manual lock applied', {
        unit_id:        body.unit_id,
        serial_number:  unitSnap?.serial_number,
        lock_record_id: lockRow.lock_record_id,
        lock_authority: lockAuthority,
      })

      return jsonResponse(req, {
        action:          'lock',
        unit_id:         body.unit_id,
        serial_number:   unitSnap?.serial_number ?? null,
        lock_record_id:  lockRow.lock_record_id,
        ledger_entry_id: lockRow.ledger_entry_id,
        lock_authority:  lockAuthority,
      })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UNLOCK branch
    // ══════════════════════════════════════════════════════════════════════════

    // ── Validate unlock fields ────────────────────────────────────────────────

    if (!body.lock_record_id || !UUID_RE.test(body.lock_record_id)) {
      return jsonError(req, 'lock_record_id must be a valid UUID.', 400)
    }

    if (!body.release_reason || typeof body.release_reason !== 'string' ||
        body.release_reason.trim().length === 0) {
      return jsonError(
        req,
        'release_reason is required. ' +
        'Document why this lock is being released (visible in the audit trail).',
        400,
      )
    }

    // ── Pre-flight: fetch lock_record ─────────────────────────────────────────

    authedLog.info('Fetching lock record', { lock_record_id: body.lock_record_id })

    const { data: lockRecord, error: fetchError } = await admin
      .from('lock_records')
      .select('id, scope, target_id, target_label, lock_authority, is_active')
      .eq('id', body.lock_record_id)
      .single()

    if (fetchError !== null || lockRecord === null) {
      authedLog.warn('Lock record not found', { lock_record_id: body.lock_record_id })
      return jsonError(req, `Lock record '${body.lock_record_id}' not found.`, 404)
    }

    const lock = lockRecord as LockRecord

    if (lock.scope !== 'unit') {
      return jsonError(
        req,
        `Lock record '${body.lock_record_id}' has scope '${lock.scope}'. ` +
        "This endpoint only releases unit-scope locks.",
        400,
      )
    }

    if (!lock.is_active) {
      return jsonError(
        req,
        `Lock record '${body.lock_record_id}' has already been released. ` +
        'Use view-unit-history to inspect the release details.',
        400,
      )
    }

    // ── Release lock ──────────────────────────────────────────────────────────

    authedLog.info('Releasing manual lock', {
      lock_record_id:   body.lock_record_id,
      lock_authority:   lock.lock_authority,
      serial_number:    lock.target_label,
    })

    const { data: releaseRows, error: releaseError } = await admin.rpc(
      'release_unit_lock',
      {
        p_lock_record_id:      body.lock_record_id,
        p_released_by:         authorized.id,
        p_release_reason:      body.release_reason.trim(),
        p_release_authority:   'gtg_admin',
        p_release_reference_id: body.release_reference_id?.trim() ?? null,
      },
    )

    if (releaseError !== null) {
      const gtgMatch = releaseError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('release_unit_lock failed', { error: releaseError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const releaseRow = (releaseRows as ReleaseRow[])[0]

    authedLog.info('Manual lock released', {
      lock_record_id:   body.lock_record_id,
      unit_id:          releaseRow.unit_id,
      serial_number:    lock.target_label,
      restored_status:  releaseRow.restored_status,
    })

    return jsonResponse(req, {
      action:           'unlock',
      unit_id:          releaseRow.unit_id,
      serial_number:    lock.target_label,
      lock_record_id:   body.lock_record_id,
      restored_status:  releaseRow.restored_status,
      ledger_entry_id:  releaseRow.ledger_entry_id,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
