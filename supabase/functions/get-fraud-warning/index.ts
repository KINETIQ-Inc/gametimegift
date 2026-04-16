/**
 * GTG Edge Function — get-fraud-warning
 *
 * Public fraud warning lookup for hologram verification (5C-3).
 * Given a serial number, returns a public-safe fraud warning indicating whether
 * the item presents any authenticity concerns — without exposing internal
 * investigation details, notes, or actor identities.
 *
 * ─── When to call this endpoint ───────────────────────────────────────────────
 *
 * Call get-fraud-warning after verify-serial (5C-1) when the caller wants to
 * surface a specific authenticity concern to the end user. Common triggers:
 *
 *   - verify-serial returned verification_status = "under_review" or "decommissioned"
 *   - A customer reports the physical hologram looks tampered or inconsistent
 *   - A QR code scan leads to a serial that does not match the printed label
 *
 * A serial number that does not exist in GTG's system is itself the strongest
 * counterfeit indicator — this endpoint returns an "alert" for unrecognized serials
 * rather than a 404, because the caller is performing authenticity verification,
 * not inventory lookup.
 *
 * ─── Warning levels ───────────────────────────────────────────────────────────
 *
 *   none         No concerns detected. Unit is genuine, in circulation, no active flags.
 *
 *   caution      A concern has been noted but is not confirmed. The unit may be
 *                under review. Do not transact until resolved.
 *
 *   alert        A serious concern is confirmed or the serial is unrecognized.
 *                Do not accept the item. Contact GTG immediately.
 *
 * ─── Warning codes ────────────────────────────────────────────────────────────
 *
 *   none             No active concerns.
 *   not_recognized   Serial number is not in GTG's records — possible counterfeit.
 *   under_review     Unit has been flagged and is under internal review.
 *   confirmed_fraud  Fraud on this unit has been confirmed by GTG investigators.
 *   decommissioned   Unit has been permanently removed from circulation.
 *
 * ─── Security design ──────────────────────────────────────────────────────────
 *
 * Fraud flag details (investigation notes, signal metadata, actor identities,
 * raising authority, and resolution notes) are NEVER exposed. The public caller
 * receives only the warning level, warning code, a pre-defined guidance message,
 * and the date of the most relevant flag — sufficient to take action without
 * compromising active investigations.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * This endpoint requires NO authentication. It is fully public.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-fraud-warning
 *   Content-Type: application/json
 *   {
 *     "serial_number": "GTG-CLC-2026-0001"
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 — no active concerns:
 *   {
 *     "data": {
 *       "serial_number":  "GTG-CLC-2026-0001",
 *       "has_warning":    false,
 *       "warning_level":  "none",
 *       "warning_code":   "none",
 *       "headline":       null,
 *       "guidance":       null,
 *       "flagged_at":     null
 *     }
 *   }
 *
 *   200 — active concern present:
 *   {
 *     "data": {
 *       "serial_number":  "GTG-CLC-2026-0001",
 *       "has_warning":    true,
 *       "warning_level":  "alert",
 *       "warning_code":   "confirmed_fraud",
 *       "headline":       "This product has been identified as fraudulent.",
 *       "guidance":       "Do not accept this item. Contact support@gametimegift.com immediately.",
 *       "flagged_at":     "2026-02-15T10:00:00Z"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (missing or invalid serial_number)
 *   500  Internal server error
 *
 * Note: Unrecognized serial numbers return 200 with warning_level = "alert" and
 * warning_code = "not_recognized", not 404. This is intentional — callers are
 * performing authenticity verification, where "not found" is itself a warning.
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse } from '../_shared/response.ts'
import { createAdminClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SERIAL_LENGTH = 100

// Statuses that indicate an active (non-resolved) fraud flag.
const ACTIVE_FLAG_STATUSES = ['open', 'under_review', 'escalated', 'confirmed']

// ─── Types ────────────────────────────────────────────────────────────────────

type WarningLevel = 'none' | 'caution' | 'alert'
type WarningCode  = 'none' | 'not_recognized' | 'under_review' | 'confirmed_fraud' | 'decommissioned'

interface RequestBody {
  serial_number?: unknown
}

interface UnitRow {
  id:     string
  status: string
}

interface FlagRow {
  status:     string
  severity:   string
  created_at: string
}

interface Warning {
  warning_level: WarningLevel
  warning_code:  WarningCode
  headline:      string | null
  guidance:      string | null
  flagged_at:    string | null
}

// ─── Warning catalogue ────────────────────────────────────────────────────────
// Pre-defined public-safe messages keyed by warning_code.
// Internal investigation details are never included.

const WARNINGS: Record<WarningCode, { headline: string; guidance: string }> = {
  none: {
    headline: '',
    guidance: '',
  },
  not_recognized: {
    headline: 'This serial number is not recognised by GTG.',
    guidance:
      'This item may not be a genuine Game Time Gift product. ' +
      'Do not complete any transaction. ' +
      'Contact support@gametimegift.com with a photo of the hologram label.',
  },
  under_review: {
    headline: 'This item is currently under authenticity review.',
    guidance:
      'GTG has an open inquiry on this product. ' +
      'Do not complete any transaction until the review is resolved. ' +
      'Contact support@gametimegift.com for assistance.',
  },
  confirmed_fraud: {
    headline: 'This item has been identified as fraudulent.',
    guidance:
      'GTG investigators have confirmed a fraud concern on this product. ' +
      'Do not accept or transact with this item under any circumstances. ' +
      'Contact support@gametimegift.com immediately and retain the item for inspection.',
  },
  decommissioned: {
    headline: 'This item has been removed from circulation.',
    guidance:
      'This product is no longer active in GTG\'s inventory. ' +
      'If you received this item as new merchandise, contact support@gametimegift.com.',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine the warning for a unit that EXISTS in the DB.
 * Applies the highest-severity concern found across unit status and active flags.
 */
function determineWarning(unitStatus: string, activeFlags: FlagRow[]): Warning {
  // Confirmed fraud flag — highest concern regardless of unit status.
  const confirmedFlag = activeFlags.find((f) => f.status === 'confirmed')
  if (confirmedFlag) {
    return {
      warning_level: 'alert',
      warning_code:  'confirmed_fraud',
      ...WARNINGS.confirmed_fraud,
      flagged_at:    confirmedFlag.created_at,
    }
  }

  // Unit permanently decommissioned.
  if (unitStatus === 'voided') {
    // If there were active non-dismissed flags alongside the void, surface under_review.
    // Otherwise surface decommissioned (could be an unrelated write-off).
    const hasActiveInvestigation = activeFlags.length > 0
    return hasActiveInvestigation
      ? {
          warning_level: 'caution',
          warning_code:  'under_review',
          ...WARNINGS.under_review,
          flagged_at:    activeFlags[0].created_at,
        }
      : {
          warning_level: 'caution',
          warning_code:  'decommissioned',
          ...WARNINGS.decommissioned,
          flagged_at:    null,
        }
  }

  // Fraud locked — active investigation, outcome not yet confirmed.
  if (unitStatus === 'fraud_locked') {
    const mostRecent = activeFlags[0] ?? null
    return {
      warning_level: 'caution',
      warning_code:  'under_review',
      ...WARNINGS.under_review,
      flagged_at:    mostRecent?.created_at ?? null,
    }
  }

  // Active open/under_review/escalated flags on a non-locked unit.
  // (Possible if flag was raised at low/medium severity — no auto-lock.)
  const openFlag = activeFlags.find((f) => f.status !== 'confirmed')
  if (openFlag) {
    return {
      warning_level: 'caution',
      warning_code:  'under_review',
      ...WARNINGS.under_review,
      flagged_at:    openFlag.created_at,
    }
  }

  // No concerns.
  return {
    warning_level: 'none',
    warning_code:  'none',
    headline:      null,
    guidance:      null,
    flagged_at:    null,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('get-fraud-warning', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Parse request body ───────────────────────────────────────────

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    // ── Step 4: Validate serial_number ──────────────────────────────────────

    if (body.serial_number === undefined || body.serial_number === null) {
      return jsonError(req, 'serial_number is required.', 400)
    }

    if (typeof body.serial_number !== 'string') {
      return jsonError(req, 'serial_number must be a string.', 400)
    }

    const serialNumber = body.serial_number.trim().toUpperCase()

    if (serialNumber.length === 0) {
      return jsonError(req, 'serial_number must not be empty.', 400)
    }

    if (serialNumber.length > MAX_SERIAL_LENGTH) {
      return jsonError(
        req,
        `serial_number must be at most ${MAX_SERIAL_LENGTH} characters.`,
        400,
      )
    }

    log.info('Fraud warning lookup', { serial_number: serialNumber })

    const admin = createAdminClient()

    // ── Step 5: Look up the unit ────────────────────────────────────────────
    // Admin client — bypasses RLS. Only id and status needed; no sensitive
    // fields are read or returned.

    const { data: unitData, error: unitError } = await admin
      .from('serialized_units')
      .select('id, status')
      .eq('serial_number', serialNumber)
      .maybeSingle()

    if (unitError !== null) {
      log.error('Unit lookup failed', { error: unitError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 6: Unrecognized serial — strongest public counterfeit signal ────
    // Return 200 with alert-level warning rather than 404. The caller is
    // performing authenticity verification: "not found" is itself a warning,
    // not a lookup failure.

    if (unitData === null) {
      log.info('Serial number not recognized', { serial_number: serialNumber })

      return jsonResponse(req, {
        serial_number:  serialNumber,
        has_warning:    true,
        warning_level:  'alert'         as WarningLevel,
        warning_code:   'not_recognized' as WarningCode,
        headline:       WARNINGS.not_recognized.headline,
        guidance:       WARNINGS.not_recognized.guidance,
        flagged_at:     null,
      })
    }

    const unit = unitData as UnitRow

    // ── Step 7: Fetch active fraud flags ────────────────────────────────────
    // Retrieve all non-dismissed flags for this unit, ordered by severity
    // (critical first) then by creation date (most recent first).
    // Only status and created_at are read — investigation details are never
    // surfaced to the public caller.

    const { data: flagData, error: flagError } = await admin
      .from('fraud_flags')
      .select('status, severity, created_at')
      .eq('unit_id', unit.id)
      .in('status', ACTIVE_FLAG_STATUSES)
      .order('severity', { ascending: false }) // critical > high > medium > low
      .order('created_at', { ascending: false })

    if (flagError !== null) {
      log.error('Fraud flags lookup failed', { error: flagError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const activeFlags = (flagData ?? []) as FlagRow[]

    // ── Step 8: Determine warning and build response ─────────────────────────

    const warning = determineWarning(unit.status, activeFlags)

    log.info('Fraud warning determined', {
      serial_number:  serialNumber,
      unit_status:    unit.status,
      active_flags:   activeFlags.length,
      warning_level:  warning.warning_level,
      warning_code:   warning.warning_code,
    })

    return jsonResponse(req, {
      serial_number:  serialNumber,
      has_warning:    warning.warning_level !== 'none',
      warning_level:  warning.warning_level,
      warning_code:   warning.warning_code,
      headline:       warning.headline,
      guidance:       warning.guidance,
      flagged_at:     warning.flagged_at,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
