/**
 * GTG Edge Function — resolve-fraud-flag
 *
 * Resolves a fraud flag investigation to a terminal status (4E-2).
 * Closes the investigative record and, when dismissing, atomically releases
 * all active unit-scope locks linked to the flag.
 *
 * ─── Resolutions ──────────────────────────────────────────────────────────────
 *
 *   confirmed   Fraud verified. The fraud_flag is closed as confirmed.
 *               Any associated unit lock remains in force — the unit stays
 *               fraud_locked. Further action (voiding the unit, licensor
 *               report) is taken separately.
 *
 *   dismissed   False positive. The fraud_flag is closed as dismissed.
 *               All active unit-scope lock_records linked to this flag
 *               (via lock_records.fraud_flag_id) are released via
 *               release_unit_lock — restoring each unit's pre-lock status,
 *               clearing fraud lock fields, and appending a fraud_released
 *               ledger entry. Lock release uses gtg_admin authority.
 *
 * ─── Eligible flags ───────────────────────────────────────────────────────────
 *
 * The flag must be in an active investigation state: open, under_review, or
 * escalated. Flags already at confirmed or dismissed are terminal and cannot
 * be re-resolved.
 *
 * ─── Lock release ordering ────────────────────────────────────────────────────
 *
 * On dismissal, locks are released before the flag is updated. If a lock
 * release fails, the flag remains in its current state (consistent) and the
 * error is returned — the admin can retry or release remaining locks via
 * manual-lock-unit (4B-4) before retrying. No partial state is silently
 * committed.
 *
 * ─── Relationship to release_unit_lock ────────────────────────────────────────
 *
 * Each lock is released via the release_unit_lock DB function — the same
 * atomic procedure used by manual-lock-unit. This guarantees that each
 * release touches serialized_units, lock_records, and inventory_ledger_entries
 * in a single transaction per lock.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Resolving a fraud investigation is an enforcement action with compliance
 * and financial consequences.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/resolve-fraud-flag
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   Confirm fraud:
 *   {
 *     "fraud_flag_id":   "<uuid>",
 *     "resolution":      "confirmed",
 *     "resolution_note": "Hologram serial cross-referenced with CLC database. Confirmed counterfeit."
 *   }
 *
 *   Dismiss (false positive):
 *   {
 *     "fraud_flag_id":       "<uuid>",
 *     "resolution":          "dismissed",
 *     "resolution_note":     "Investigation complete. Duplicate serial was a data entry error. Unit cleared.",
 *     "release_reference_id": "CLC-CLEAR-2026-007"   // optional — licensor clearance doc
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "fraud_flag_id":  "<uuid>",
 *       "unit_id":        "<uuid>",
 *       "serial_number":  "GTG-CLC-2026-0001",
 *       "resolution":     "dismissed",
 *       "status":         "dismissed",
 *       "resolution_note": "...",
 *       "resolved_at":    "2026-03-06T...",
 *       "resolved_by":    "<uuid>",
 *       "locks_released": [
 *         {
 *           "lock_record_id":  "<uuid>",
 *           "unit_id":         "<uuid>",
 *           "restored_status": "available",
 *           "ledger_entry_id": "<uuid>"
 *         }
 *       ]
 *     }
 *   }
 *
 *   For confirmed resolution, locks_released is always [].
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or flag already at terminal status (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Fraud flag not found
 *   500  Internal server error (including failed lock release)
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Statuses from which a flag may be resolved
const RESOLVABLE_STATUSES = new Set(['open', 'under_review', 'escalated'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  fraud_flag_id?:       string
  resolution?:          string
  resolution_note?:     string
  release_reference_id?: string
}

interface FraudFlag {
  id:            string
  unit_id:       string
  serial_number: string
  sku:           string
  status:        string
}

interface LockRecord {
  id: string
}

interface ReleaseRow {
  unit_id:         string
  restored_status: string
  ledger_entry_id: string
}

interface ReleasedLock {
  lock_record_id:  string
  unit_id:         string
  restored_status: string
  ledger_entry_id: string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('resolve-fraud-flag', req)
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

    if (!body.resolution || (body.resolution !== 'confirmed' && body.resolution !== 'dismissed')) {
      return jsonError(
        req,
        "resolution must be 'confirmed' (fraud verified, lock remains) or " +
        "'dismissed' (false positive, associated locks released).",
        400,
      )
    }

    if (!body.resolution_note || typeof body.resolution_note !== 'string' ||
        body.resolution_note.trim().length === 0) {
      return jsonError(
        req,
        'resolution_note is required. Document the outcome of the investigation ' +
        '(visible in the audit trail and unit history).',
        400,
      )
    }

    if (body.release_reference_id !== undefined &&
        body.release_reference_id !== null &&
        (typeof body.release_reference_id !== 'string' ||
         body.release_reference_id.trim().length === 0)) {
      return jsonError(
        req,
        'release_reference_id must be a non-empty string when provided.',
        400,
      )
    }

    const admin = createAdminClient()

    // ── Step 6: Fetch and validate the fraud flag ───────────────────────────────

    authedLog.info('Fetching fraud flag', { fraud_flag_id: body.fraud_flag_id })

    const { data: flagData, error: flagError } = await admin
      .from('fraud_flags')
      .select('id, unit_id, serial_number, sku, status')
      .eq('id', body.fraud_flag_id)
      .single()

    if (flagError !== null || flagData === null) {
      authedLog.warn('Fraud flag not found', { fraud_flag_id: body.fraud_flag_id })
      return jsonError(req, `Fraud flag '${body.fraud_flag_id}' not found.`, 404)
    }

    const flag = flagData as FraudFlag

    if (!RESOLVABLE_STATUSES.has(flag.status)) {
      authedLog.warn('Flag not in resolvable status', {
        fraud_flag_id: flag.id,
        status:        flag.status,
      })
      return jsonError(
        req,
        `Fraud flag '${flag.id}' has status '${flag.status}' and cannot be resolved. ` +
        "Only flags with status 'open', 'under_review', or 'escalated' may be resolved. " +
        'Use view-unit-history to inspect the existing resolution.',
        400,
      )
    }

    const resolvedAt   = new Date().toISOString()
    const resolutionNote = body.resolution_note.trim()
    const locksReleased: ReleasedLock[] = []

    // ══════════════════════════════════════════════════════════════════════════
    // DISMISSED branch — release all active unit locks linked to this flag
    // ══════════════════════════════════════════════════════════════════════════

    if (body.resolution === 'dismissed') {

      // ── Step 7a: Fetch active unit-scope locks tied to this flag ──────────────

      const { data: lockData, error: lockFetchError } = await admin
        .from('lock_records')
        .select('id')
        .eq('fraud_flag_id', flag.id)
        .eq('scope', 'unit')
        .eq('is_active', true)

      if (lockFetchError !== null) {
        authedLog.error('Lock records query failed', { error: lockFetchError.message })
        return jsonError(req, 'Internal server error', 500)
      }

      const activeLocks = (lockData ?? []) as LockRecord[]

      authedLog.info('Releasing locks for dismissed flag', {
        fraud_flag_id: flag.id,
        lock_count:    activeLocks.length,
      })

      // ── Step 7b: Release each lock via release_unit_lock ─────────────────────
      //
      // Each call is its own transaction (atomically touches lock_records,
      // serialized_units, and inventory_ledger_entries). Locks are released
      // sequentially so a failure on one does not mask others.
      // release_authority = 'gtg_admin' — admin override authority.

      for (const lock of activeLocks) {
        const { data: releaseRows, error: releaseError } = await admin.rpc(
          'release_unit_lock',
          {
            p_lock_record_id:      lock.id,
            p_released_by:         authorized.id,
            p_release_reason:      `Fraud investigation dismissed: ${resolutionNote}`,
            p_release_authority:   'gtg_admin',
            p_release_reference_id: body.release_reference_id?.trim() ?? null,
          },
        )

        if (releaseError !== null) {
          const gtgMatch = releaseError.message.match(/\[GTG\][^.]+\./)
          authedLog.error('Lock release failed', {
            lock_record_id: lock.id,
            error:          releaseError.message,
          })
          return jsonError(
            req,
            gtgMatch
              ? gtgMatch[0]
              : `Failed to release lock '${lock.id}'. ` +
                `${locksReleased.length} of ${activeLocks.length} locks were released before this error. ` +
                'Retry or release remaining locks via manual-lock-unit.',
            500,
          )
        }

        const releaseRow = (releaseRows as ReleaseRow[])[0]
        locksReleased.push({
          lock_record_id:  lock.id,
          unit_id:         releaseRow.unit_id,
          restored_status: releaseRow.restored_status,
          ledger_entry_id: releaseRow.ledger_entry_id,
        })

        authedLog.info('Lock released', {
          lock_record_id:  lock.id,
          unit_id:         releaseRow.unit_id,
          restored_status: releaseRow.restored_status,
        })
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Update fraud_flag to terminal status
    // ══════════════════════════════════════════════════════════════════════════

    // ── Step 8: Resolve the fraud flag ─────────────────────────────────────────

    authedLog.info('Resolving fraud flag', {
      fraud_flag_id: flag.id,
      resolution:    body.resolution,
    })

    const { error: updateError } = await admin
      .from('fraud_flags')
      .update({
        status:          body.resolution,
        resolution_note: resolutionNote,
        resolved_at:     resolvedAt,
        resolved_by:     authorized.id,
      })
      .eq('id', flag.id)

    if (updateError !== null) {
      authedLog.error('Fraud flag update failed', { error: updateError.message })
      // Locks may have already been released at this point (dismissed path).
      // The locks are correctly released; only the flag status update failed.
      // Return 500 with context so the admin can manually close the flag.
      return jsonError(
        req,
        'Lock(s) were released but the fraud flag status could not be updated. ' +
        'Please manually close the flag record. Error: ' + updateError.message,
        500,
      )
    }

    authedLog.info('Fraud flag resolved', {
      fraud_flag_id:  flag.id,
      resolution:     body.resolution,
      locks_released: locksReleased.length,
    })

    return jsonResponse(req, {
      fraud_flag_id:   flag.id,
      unit_id:         flag.unit_id,
      serial_number:   flag.serial_number,
      resolution:      body.resolution,
      status:          body.resolution,
      resolution_note: resolutionNote,
      resolved_at:     resolvedAt,
      resolved_by:     authorized.id,
      locks_released:  locksReleased,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
