/**
 * GTG Edge Function — lock-units
 *
 * Applies a fraud lock to one or more serialized units. Each lock:
 *   1. Transitions the unit's status to 'fraud_locked'.
 *   2. Creates a lock_records row (enforcement audit record).
 *   3. Appends an inventory_ledger_entries row (compliance trail).
 *
 * All three writes are executed atomically per unit via the lock_unit()
 * database function (migration 19). A failure on any write rolls back
 * the entire unit's operation without affecting other units in the batch.
 *
 * Lockable statuses: available, reserved, sold, returned.
 * Non-lockable: fraud_locked (already locked), voided (terminal).
 *
 * Authorization: ADMIN_ROLES only. Locking is a compliance action that
 * requires admin authority. Automated system locks (lock_authority='system')
 * are also called through this function, with the service account's JWT.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/lock-units
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   {
 *     "unit_ids": ["uuid", ...],            // 1–50 units; required
 *     "lock_reason": "string",              // required; recorded on all three writes
 *     "lock_authority": "gtg_admin",        // required; one of: gtg_admin, clc, army, system
 *     "fraud_flag_id": "uuid",              // optional; links lock to an existing FraudFlag
 *     "licensor_reference_id": "string"     // required when lock_authority is clc or army
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "summary": {
 *         "total": 2,
 *         "locked": 1,
 *         "failed": 1,
 *         "all_locked": false
 *       },
 *       "results": [
 *         {
 *           "unit_id": "...",
 *           "locked": true,
 *           "serial_number": "GTG-ABC123",
 *           "lock_record_id": "...",
 *           "ledger_entry_id": "..."
 *         },
 *         {
 *           "unit_id": "...",
 *           "locked": false,
 *           "error": "unit 'GTG-XYZ789' has status 'voided' and cannot be fraud-locked."
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing / invalid fields)
 *   401  Unauthenticated
 *   403  Forbidden (not an admin)
 *   500  Internal server error (unexpected DB failure)
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve lock-units --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/lock-units' \
 *     --header 'Authorization: Bearer <admin-jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{
 *       "unit_ids": ["<uuid>"],
 *       "lock_reason": "Hologram scan failed at retail event",
 *       "lock_authority": "gtg_admin"
 *     }'
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UNIT_IDS = 50

const VALID_LOCK_AUTHORITIES = new Set([
  'gtg_admin',
  'clc',
  'army',
  'system',
])

/** Authorities that require a licensor_reference_id (mirrors DB check constraint). */
const LICENSOR_AUTHORITIES = new Set(['clc', 'army'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  unit_ids: string[]
  lock_reason: string
  lock_authority: string
  fraud_flag_id?: string | null
  licensor_reference_id?: string | null
}

interface LockResult {
  unit_id: string
  locked: boolean
  /** Populated on success. */
  serial_number?: string
  lock_record_id?: string
  ledger_entry_id?: string
  /** Populated on failure. */
  error?: string
}

interface LockSummary {
  total: number
  locked: number
  failed: number
  all_locked: boolean
}

interface ResponsePayload {
  summary: LockSummary
  results: LockResult[]
}

/** Shape returned by the lock_unit() DB function (RETURNS TABLE). */
interface LockUnitRpcRow {
  lock_record_id: string
  ledger_entry_id: string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('lock-units', req)
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

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
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

    // unit_ids
    if (!Array.isArray(body.unit_ids)) {
      return jsonError(req, 'unit_ids must be an array of UUID strings', 400)
    }
    if (body.unit_ids.length === 0) {
      return jsonError(req, 'unit_ids must contain at least one entry', 400)
    }
    if (body.unit_ids.length > MAX_UNIT_IDS) {
      return jsonError(
        req,
        `unit_ids may contain at most ${MAX_UNIT_IDS} entries per request (received ${body.unit_ids.length})`,
        400,
      )
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    for (const id of body.unit_ids) {
      if (typeof id !== 'string' || !uuidPattern.test(id)) {
        return jsonError(req, `Invalid unit_id: "${id}". All entries must be valid UUID v4 strings.`, 400)
      }
    }

    // lock_reason
    if (!body.lock_reason || typeof body.lock_reason !== 'string' || body.lock_reason.trim() === '') {
      return jsonError(req, 'lock_reason is required and must be a non-empty string', 400)
    }

    // lock_authority
    if (!body.lock_authority || !VALID_LOCK_AUTHORITIES.has(body.lock_authority)) {
      return jsonError(
        req,
        `lock_authority must be one of: ${[...VALID_LOCK_AUTHORITIES].join(', ')}`,
        400,
      )
    }

    // licensor_reference_id required for clc / army
    if (
      LICENSOR_AUTHORITIES.has(body.lock_authority) &&
      (!body.licensor_reference_id || body.licensor_reference_id.trim() === '')
    ) {
      return jsonError(
        req,
        `licensor_reference_id is required when lock_authority is '${body.lock_authority}'`,
        400,
      )
    }

    // fraud_flag_id — optional, but must be a valid UUID if provided
    if (
      body.fraud_flag_id !== undefined &&
      body.fraud_flag_id !== null &&
      !uuidPattern.test(body.fraud_flag_id)
    ) {
      return jsonError(req, 'fraud_flag_id must be a valid UUID v4 if provided', 400)
    }

    // Deduplicate unit IDs silently.
    const unitIds = [...new Set<string>(body.unit_ids)]

    authedLog.info('Locking units', {
      count: unitIds.length,
      lock_authority: body.lock_authority,
      has_fraud_flag: body.fraud_flag_id != null,
    })

    // ── Step 6: Execute per-unit locks via DB function ────────────────────────
    // Each unit is locked in its own transaction via lock_unit().
    // A failure on one unit does not roll back others — the caller receives
    // a per-unit result and can decide how to handle partial failures.
    //
    // lock_unit() atomically:
    //   1. SELECT FOR UPDATE the unit (row-level lock, prevents concurrent locks)
    //   2. UPDATE serialized_units (status → fraud_locked, fraud lock fields)
    //   3. INSERT lock_records
    //   4. INSERT inventory_ledger_entries
    //
    // Calls are sequential (not parallel) to avoid overwhelming the DB connection
    // pool. 50 lightweight transactions with single-row touches complete in well
    // under 1 second on a local Supabase instance.

    const admin = createAdminClient()
    const results: LockResult[] = []

    for (const unitId of unitIds) {
      const { data, error } = await admin.rpc('lock_unit', {
        p_unit_id:               unitId,
        p_performed_by:          authorized.id,
        p_lock_reason:           body.lock_reason.trim(),
        p_lock_authority:        body.lock_authority,
        p_fraud_flag_id:         body.fraud_flag_id ?? null,
        p_licensor_reference_id: body.licensor_reference_id ?? null,
      })

      if (error !== null) {
        // Extract the GTG-prefixed message from the Postgres exception when
        // possible; fall back to the raw message for unexpected errors.
        const raw = error.message ?? 'Unknown DB error'
        const match = raw.match(/\[GTG\][^.]+\./)
        const userMessage = match ? match[0] : raw

        authedLog.warn('Lock failed', { unit_id: unitId, error: raw })
        results.push({ unit_id: unitId, locked: false, error: userMessage })
        continue
      }

      // lock_unit returns RETURNS TABLE — Supabase wraps it in an array.
      const row = (data as LockUnitRpcRow[] | null)?.[0]

      if (row === undefined || row === null) {
        authedLog.error('lock_unit returned no rows', { unit_id: unitId })
        results.push({
          unit_id: unitId,
          locked: false,
          error: 'Lock function returned no result. This is unexpected — check server logs.',
        })
        continue
      }

      authedLog.info('Unit locked', {
        unit_id: unitId,
        lock_record_id: row.lock_record_id,
        ledger_entry_id: row.ledger_entry_id,
      })

      results.push({
        unit_id: unitId,
        locked: true,
        lock_record_id: row.lock_record_id,
        ledger_entry_id: row.ledger_entry_id,
      })
    }

    // ── Step 7: Build summary and respond ────────────────────────────────────

    const lockedCount = results.filter((r) => r.locked).length
    const failedCount = results.length - lockedCount

    const summary: LockSummary = {
      total: results.length,
      locked: lockedCount,
      failed: failedCount,
      all_locked: failedCount === 0,
    }

    authedLog.info('Lock operation complete', {
      total: summary.total,
      locked: summary.locked,
      failed: summary.failed,
    })

    const payload: ResponsePayload = { summary, results }
    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
