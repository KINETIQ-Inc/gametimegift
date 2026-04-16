/**
 * GTG Edge Function — validate-serialized-units
 *
 * Checks one or more serialized units for sale eligibility.
 *
 * Called during order building — when a consultant scans or selects a unit to
 * add to a draft order — to provide immediate per-unit feedback before the
 * unit is written to an order_line. Accepts up to 50 unit IDs per request.
 *
 * Validations per unit (all must pass for `valid: true`):
 *   1. Unit record exists in the database.
 *   2. Serial number matches the required format (^[A-Z0-9][A-Z0-9-]{5,63}$).
 *   3. Unit status is 'available' — the only status from which a new order line
 *      may be opened. (Existing reserved units are validated by validate-order.)
 *   4. Hologram record is present — every sellable unit must carry an applied
 *      authentication hologram.
 *   5. Hologram fields are complete: hologramId, batchId, appliedAt, appliedBy
 *      are all non-empty strings.
 *   6. cost_cents > 0 — a zero-cost unit indicates a data entry error.
 *   7. royalty_rate is in [0, 1] — catches both negative rates and rates that
 *      exceed 100%, which would make royalty_cents > retail_price_cents.
 *   8. No active fraud flags — status ∈ {'open', 'under_review', 'escalated'}.
 *      Confirmed or dismissed flags do not block sale.
 *
 * Authorization: admins and consultants. Customers do not select raw units —
 * they select products; unit assignment is handled server-side.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/validate-serialized-units
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *   { "unit_ids": ["uuid", "uuid", ...] }   // 1–50 IDs
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "summary": {
 *         "total": 3,
 *         "valid": 2,
 *         "invalid": 1,
 *         "all_valid": false
 *       },
 *       "results": [
 *         {
 *           "unit_id": "...",
 *           "valid": true,
 *           "serial_number": "GTG-ABC123",
 *           "sku": "GTG-001",
 *           "product_name": "Army Football Jersey #12",
 *           "status": "available"
 *         },
 *         {
 *           "unit_id": "...",
 *           "valid": false,
 *           "serial_number": "GTG-XYZ789",
 *           "sku": "GTG-002",
 *           "product_name": "Army Helmet",
 *           "status": "fraud_locked",
 *           "errors": [
 *             {
 *               "code": "WRONG_STATUS",
 *               "message": "Unit has status 'fraud_locked'. Only 'available' units may be added to an order."
 *             },
 *             {
 *               "code": "ACTIVE_FRAUD_FLAG",
 *               "message": "Unit has 1 active fraud flag(s): open/high (hologram_scan_fail)."
 *             }
 *           ]
 *         },
 *         {
 *           "unit_id": "...",
 *           "valid": false,
 *           "errors": [{ "code": "NOT_FOUND", "message": "Unit not found." }]
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing unit_ids, wrong type, out-of-range count)
 *   401  Unauthenticated
 *   403  Forbidden (role not permitted)
 *   500  Internal server error
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve validate-serialized-units --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/validate-serialized-units' \
 *     --header 'Authorization: Bearer <jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{"unit_ids": ["<uuid>"]}'
 */

import { verifyRole } from '../_shared/auth.ts'
import type { AppRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Roles that may validate units for order inclusion. Customers do not call this. */
const UNIT_VALIDATION_ROLES: readonly AppRole[] = [
  'super_admin',
  'admin',
  'consultant',
]

/** Maximum units per request — prevents oversized DB queries. */
const MAX_UNIT_IDS = 50

/** Serial number format: 6–64 uppercase alphanumeric + hyphens, no leading hyphen. */
const SERIAL_NUMBER_FORMAT = /^[A-Z0-9][A-Z0-9-]{5,63}$/

/** Fraud flag statuses that block a unit from being sold. */
const ACTIVE_FRAUD_FLAG_STATUSES = new Set(['open', 'under_review', 'escalated'])

/** Required non-empty string fields inside the hologram JSONB object. */
const REQUIRED_HOLOGRAM_FIELDS = ['hologramId', 'batchId', 'appliedAt', 'appliedBy'] as const

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  unit_ids: string[]
}

type UnitValidationErrorCode =
  | 'NOT_FOUND'           // No row with this unit_id
  | 'SERIAL_FORMAT'       // serial_number fails the format check
  | 'WRONG_STATUS'        // Status is not 'available'
  | 'NO_HOLOGRAM'         // hologram field is null (label not yet applied)
  | 'INCOMPLETE_HOLOGRAM' // hologram is present but a required field is empty
  | 'ZERO_COST'           // cost_cents ≤ 0
  | 'INVALID_ROYALTY_RATE'// royalty_rate < 0 or > 1
  | 'ACTIVE_FRAUD_FLAG'   // One or more open/under_review/escalated fraud flags

interface UnitValidationError {
  code: UnitValidationErrorCode
  message: string
}

interface UnitValidationResult {
  unit_id: string
  valid: boolean
  /** Populated whenever the unit row was found. */
  serial_number?: string
  sku?: string
  product_name?: string
  status?: string
  errors?: UnitValidationError[]
}

interface ValidationSummary {
  total: number
  valid: number
  invalid: number
  all_valid: boolean
}

interface ResponsePayload {
  summary: ValidationSummary
  results: UnitValidationResult[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unitError(
  code: UnitValidationErrorCode,
  message: string,
): UnitValidationError {
  return { code, message }
}

/** Validate a hologram JSONB object. Returns any errors found. */
function checkHologram(
  hologram: Record<string, unknown> | null,
): UnitValidationError[] {
  if (hologram === null) {
    return [unitError(
      'NO_HOLOGRAM',
      'Unit does not have an applied hologram. A hologram must be affixed before the unit can be sold.',
    )]
  }

  const errors: UnitValidationError[] = []

  for (const field of REQUIRED_HOLOGRAM_FIELDS) {
    const value = hologram[field]
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(unitError(
        'INCOMPLETE_HOLOGRAM',
        `hologram.${field} is required and must be a non-empty string.`,
      ))
    }
  }

  return errors
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('validate-serialized-units', req)
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

    const { authorized, denied } = verifyRole(user, UNIT_VALIDATION_ROLES, req)
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

    // Deduplicate — the caller may submit the same ID twice by mistake.
    const unitIds = [...new Set<string>(body.unit_ids)]

    authedLog.info('Validating units', { count: unitIds.length })

    // ── Step 6: Fetch units with their active fraud flags ─────────────────────
    // Left-join fraud_flags so that units without any flags are still returned.
    // The fraud flag filter (active statuses only) is applied in JS after fetch
    // because Supabase's PostgREST does not support WHERE on nested select in a
    // way that would simultaneously keep the parent row when no child rows match.

    const admin = createAdminClient()

    const { data: units, error: queryError } = await admin
      .from('serialized_units')
      .select(`
        id,
        serial_number,
        sku,
        product_name,
        status,
        hologram,
        cost_cents,
        royalty_rate,
        fraud_flags ( id, status, severity, source )
      `)
      .in('id', unitIds)

    if (queryError !== null) {
      authedLog.error('DB error fetching units', { code: queryError.code })
      return jsonError(req, 'Internal server error', 500)
    }

    // Build a lookup map from the fetched rows for O(1) access below.
    const unitMap = new Map(
      (units ?? []).map((u) => [u.id, u]),
    )

    authedLog.info('DB fetch complete', {
      requested: unitIds.length,
      found: unitMap.size,
    })

    // ── Step 7: Per-unit validation ───────────────────────────────────────────

    const results: UnitValidationResult[] = []

    for (const unitId of unitIds) {
      const unit = unitMap.get(unitId)

      // ── Check 1: Unit exists ───────────────────────────────────────────────
      if (unit === undefined) {
        results.push({
          unit_id: unitId,
          valid: false,
          errors: [unitError('NOT_FOUND', 'Unit not found.')],
        })
        continue
      }

      const errors: UnitValidationError[] = []

      // ── Check 2: Serial number format ──────────────────────────────────────
      if (!SERIAL_NUMBER_FORMAT.test(unit.serial_number)) {
        errors.push(unitError(
          'SERIAL_FORMAT',
          `Serial number "${unit.serial_number}" does not match the required format ` +
          `(6–64 uppercase alphanumeric characters and hyphens; must start with a letter or digit).`,
        ))
      }

      // ── Check 3: Status is 'available' ─────────────────────────────────────
      if (unit.status !== 'available') {
        errors.push(unitError(
          'WRONG_STATUS',
          `Unit has status '${unit.status}'. Only 'available' units may be added to an order. ` +
          `'reserved' units are validated via validate-order for payment retry flows.`,
        ))
      }

      // ── Check 4 & 5: Hologram record ───────────────────────────────────────
      const hologram = unit.hologram as Record<string, unknown> | null
      errors.push(...checkHologram(hologram))

      // ── Check 6: cost_cents > 0 ────────────────────────────────────────────
      if (unit.cost_cents <= 0) {
        errors.push(unitError(
          'ZERO_COST',
          `Unit cost_cents is ${unit.cost_cents}. Cost must be at least 1 cent. ` +
          `A zero-cost unit indicates a data entry error during inventory receiving.`,
        ))
      }

      // ── Check 7: royalty_rate in [0, 1] ────────────────────────────────────
      if (unit.royalty_rate < 0 || unit.royalty_rate > 1) {
        errors.push(unitError(
          'INVALID_ROYALTY_RATE',
          `Unit royalty_rate is ${unit.royalty_rate}. Rate must be between 0 and 1 inclusive ` +
          `(e.g. 0.145 = 14.5%). Values outside this range produce incorrect royalty calculations.`,
        ))
      }

      // ── Check 8: No active fraud flags ─────────────────────────────────────
      // fraud_flags is returned as an array (one-to-many). Filter to active ones.
      const flagRows = Array.isArray(unit.fraud_flags) ? unit.fraud_flags : []

      const activeFlags = flagRows.filter(
        (f) => ACTIVE_FRAUD_FLAG_STATUSES.has(f.status as string),
      )

      if (activeFlags.length > 0) {
        const summary = activeFlags
          .map((f) => `${f.status}/${f.severity} (${f.source})`)
          .join(', ')

        errors.push(unitError(
          'ACTIVE_FRAUD_FLAG',
          `Unit has ${activeFlags.length} active fraud flag(s): ${summary}. ` +
          `The flag(s) must be resolved (confirmed or dismissed) before this unit can be sold.`,
        ))
      }

      results.push({
        unit_id: unitId,
        valid: errors.length === 0,
        serial_number: unit.serial_number,
        sku: unit.sku,
        product_name: unit.product_name,
        status: unit.status,
        ...(errors.length > 0 ? { errors } : {}),
      })
    }

    // ── Step 8: Build summary and respond ────────────────────────────────────

    const validCount = results.filter((r) => r.valid).length
    const invalidCount = results.length - validCount

    const summary: ValidationSummary = {
      total: results.length,
      valid: validCount,
      invalid: invalidCount,
      all_valid: invalidCount === 0,
    }

    authedLog.info('Validation complete', {
      total: summary.total,
      valid: summary.valid,
      invalid: summary.invalid,
    })

    const payload: ResponsePayload = { summary, results }
    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
