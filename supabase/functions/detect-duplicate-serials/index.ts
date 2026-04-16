/**
 * GTG Edge Function — detect-duplicate-serials
 *
 * Identifies serialized units that have been sold more times than their
 * return history can legitimately explain, then creates fraud_flag records
 * (source = 'duplicate_serial', severity = 'high') and auto-locks each
 * affected unit under system authority.
 *
 * ─── Detection invariant ──────────────────────────────────────────────────────
 *
 * A unit's sold and returned ledger entries must satisfy:
 *
 *   count(sold) <= count(returned) + 1
 *
 * Any unit where count(sold) > count(returned) + 1 is flagged. Examples:
 *
 *   sold=1, returned=0  →  1 > 1  → false  (normal: one active sale)
 *   sold=2, returned=1  →  2 > 2  → false  (legitimate: sold → returned → resold)
 *   sold=2, returned=0  →  2 > 1  → TRUE   (fraud: double-sold, no return)
 *   sold=3, returned=1  →  3 > 2  → TRUE   (fraud: sold 3x, returned only once)
 *
 * ─── Two modes ────────────────────────────────────────────────────────────────
 *
 *   scan     — Full ledger scan. Intended as a periodic admin job (daily/weekly).
 *              All units in inventory_ledger_entries are examined.
 *
 *   targeted — Restrict to a caller-specified list of unit_ids (1–50).
 *              Use when a specific order or consultant has been flagged for review.
 *
 * ─── Per-unit atomicity ───────────────────────────────────────────────────────
 *
 * Each unit is processed independently via flag_duplicate_serial(). A failure
 * on one unit does not abort processing of remaining units. Failed units are
 * reported individually in the results array.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * flag_duplicate_serial() is idempotent: if an active (open, under_review,
 * escalated) duplicate_serial flag already exists for a unit, the existing
 * flag is returned with was_created = false. The summary distinguishes new
 * flags from idempotent re-detections via the already_flagged counter.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Detection is an admin-initiated compliance operation. It writes fraud_flags
 * and triggers unit locks — licensor_auditor has read-only access.
 *
 * ─── Request: scan mode ──────────────────────────────────────────────────────
 *
 *   POST /functions/v1/detect-duplicate-serials
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   { "mode": "scan" }
 *
 * ─── Request: targeted mode ──────────────────────────────────────────────────
 *
 *   POST /functions/v1/detect-duplicate-serials
 *   { "mode": "targeted", "unit_ids": ["<uuid>", ...] }   // 1–50 unit IDs
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "mode": "scan",
 *       "summary": {
 *         "duplicates_detected": 2,
 *         "flags_created": 1,
 *         "already_flagged": 1,
 *         "units_locked": 1,
 *         "units_not_locked": 0,   // already fraud_locked or voided at detection time
 *         "failed": 0
 *       },
 *       "results": [
 *         {
 *           "unit_id": "<uuid>",
 *           "serial_number": "GTG-ABC123",
 *           "sold_count": 2,
 *           "returned_count": 0,
 *           "fraud_flag_id": "<uuid>",
 *           "lock_record_id": "<uuid>",   // null if unit was already locked
 *           "was_created": true,
 *           "error": null
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (invalid mode, empty/oversized unit_ids, invalid UUID)
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

const MAX_TARGETED_UNIT_IDS = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'scan' | 'targeted'

interface RequestBody {
  mode: Mode
  unit_ids?: string[]  // targeted mode only
}

interface DetectionRow {
  unit_id:        string
  serial_number:  string
  sold_count:     number
  returned_count: number
}

interface FlagRow {
  fraud_flag_id:  string
  lock_record_id: string | null
  was_created:    boolean
}

interface UnitResult {
  unit_id:        string
  serial_number:  string
  sold_count:     number
  returned_count: number
  fraud_flag_id:  string | null
  lock_record_id: string | null
  was_created:    boolean | null
  error:          string | null
}

interface Summary {
  duplicates_detected: number
  flags_created:       number
  already_flagged:     number
  units_locked:        number
  units_not_locked:    number  // unit was already fraud_locked or voided at detection time
  failed:              number
}

interface ResponsePayload {
  mode:    Mode
  summary: Summary
  results: UnitResult[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('detect-duplicate-serials', req)
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

    if (body.mode !== 'scan' && body.mode !== 'targeted') {
      return jsonError(req, "mode must be 'scan' or 'targeted'.", 400)
    }

    // Targeted mode: validate unit_ids
    if (body.mode === 'targeted') {
      if (!Array.isArray(body.unit_ids) || body.unit_ids.length === 0) {
        return jsonError(req, 'targeted mode requires unit_ids: a non-empty array of UUIDs.', 400)
      }
      if (body.unit_ids.length > MAX_TARGETED_UNIT_IDS) {
        return jsonError(
          req,
          `targeted mode accepts at most ${MAX_TARGETED_UNIT_IDS} unit_ids per request. ` +
          `Received ${body.unit_ids.length}.`,
          400,
        )
      }
      const invalidId = body.unit_ids.find((id) => typeof id !== 'string' || !UUID_RE.test(id))
      if (invalidId !== undefined) {
        return jsonError(req, `unit_ids contains an invalid UUID: ${String(invalidId)}.`, 400)
      }
    }

    // Scan mode: unit_ids must not be provided
    if (body.mode === 'scan' && body.unit_ids !== undefined) {
      return jsonError(req, "scan mode does not accept unit_ids. Use mode: 'targeted' to restrict by unit.", 400)
    }

    const admin = createAdminClient()

    // ── Step 6: Detect duplicate serials ───────────────────────────────────────

    authedLog.info('Running duplicate serial detection', {
      mode:              body.mode,
      targeted_count:    body.mode === 'targeted' ? body.unit_ids!.length : null,
    })

    const { data: detectionRows, error: detectionError } = await admin.rpc(
      'find_duplicate_serial_unit_ids',
      { p_unit_ids: body.mode === 'targeted' ? body.unit_ids! : null },
    )

    if (detectionError !== null) {
      authedLog.error('Detection query failed', { error: detectionError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const duplicates = (detectionRows ?? []) as DetectionRow[]

    authedLog.info('Detection complete', {
      mode:               body.mode,
      duplicates_found:   duplicates.length,
    })

    // ── Step 7: Flag and auto-lock each duplicate ───────────────────────────────

    const results: UnitResult[] = []
    const summary: Summary = {
      duplicates_detected: duplicates.length,
      flags_created:       0,
      already_flagged:     0,
      units_locked:        0,
      units_not_locked:    0,
      failed:              0,
    }

    for (const dup of duplicates) {
      const description =
        `Automated detection: unit sold ${dup.sold_count} time(s) with ` +
        `${dup.returned_count} return(s) — expected at most ${dup.returned_count + 1} sale(s). ` +
        `Possible double-sale or order pipeline integrity violation.`

      const { data: flagRows, error: flagError } = await admin.rpc(
        'flag_duplicate_serial',
        {
          p_unit_id:          dup.unit_id,
          p_description:      description,
          p_related_order_id: null,
          p_signal_metadata:  {
            sold_count:     dup.sold_count,
            returned_count: dup.returned_count,
            detected_by:    'detect-duplicate-serials',
          },
          p_raised_by:        authorized.id,
        },
      )

      if (flagError !== null) {
        const gtgMatch = flagError.message.match(/\[GTG\][^.]+\./)
        const errorMsg = gtgMatch ? gtgMatch[0] : flagError.message

        authedLog.error('flag_duplicate_serial failed', {
          unit_id:      dup.unit_id,
          serial_number: dup.serial_number,
          error:        flagError.message,
        })

        results.push({
          unit_id:        dup.unit_id,
          serial_number:  dup.serial_number,
          sold_count:     dup.sold_count,
          returned_count: dup.returned_count,
          fraud_flag_id:  null,
          lock_record_id: null,
          was_created:    null,
          error:          errorMsg,
        })
        summary.failed++
        continue
      }

      const flag = (flagRows as FlagRow[])[0]!

      if (flag.was_created) {
        summary.flags_created++
        if (flag.lock_record_id !== null) {
          summary.units_locked++
        } else {
          // Unit was already fraud_locked or voided at detection time.
          summary.units_not_locked++
        }
      } else {
        summary.already_flagged++
      }

      authedLog.info('Unit processed', {
        unit_id:        dup.unit_id,
        serial_number:  dup.serial_number,
        fraud_flag_id:  flag.fraud_flag_id,
        lock_record_id: flag.lock_record_id,
        was_created:    flag.was_created,
      })

      results.push({
        unit_id:        dup.unit_id,
        serial_number:  dup.serial_number,
        sold_count:     dup.sold_count,
        returned_count: dup.returned_count,
        fraud_flag_id:  flag.fraud_flag_id,
        lock_record_id: flag.lock_record_id,
        was_created:    flag.was_created,
        error:          null,
      })
    }

    authedLog.info('Duplicate serial detection run complete', {
      mode:                body.mode,
      duplicates_detected: summary.duplicates_detected,
      flags_created:       summary.flags_created,
      already_flagged:     summary.already_flagged,
      units_locked:        summary.units_locked,
      units_not_locked:    summary.units_not_locked,
      failed:              summary.failed,
    })

    return jsonResponse(req, {
      mode: body.mode,
      summary,
      results,
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
