/**
 * GTG Edge Function — create-fraud-flag
 *
 * General-purpose fraud signal intake. Creates a fraud_flags record for any
 * fraud_signal_source that arrives from external systems, manual admin review,
 * or signals that cannot be automatically detected.
 *
 * ─── Signal sources handled here ─────────────────────────────────────────────
 *
 *   hologram_scan_fail    Hologram verification returned invalid
 *   duplicate_hologram    Hologram ID appears on more than one unit record
 *   consultant_report     Consultant self-reported a suspected counterfeit
 *   customer_report       Customer reported an authenticity concern
 *   licensor_report       CLC or Army flagged a unit in their audit
 *   admin_manual          Admin flagged manually during investigation
 *   payment_chargeback    Chargeback received; possible stolen card / resale fraud
 *   velocity_anomaly      Unusual sale rate on a serial or consultant account
 *
 * ─── Automated detection path ─────────────────────────────────────────────────
 *
 *   duplicate_serial signals come from the detect-duplicate-serials function,
 *   which uses flag_duplicate_serial() for idempotent detection + flagging.
 *   This endpoint accepts duplicate_serial as a source (manual override) but
 *   the automated detection path is preferred for that signal.
 *
 * ─── Source-specific required fields ─────────────────────────────────────────
 *
 *   source = 'licensor_report'    → reporting_licensor required ('CLC' or 'ARMY')
 *   source = 'payment_chargeback' → related_order_id required
 *   all other sources             → no additional required fields
 *
 * ─── Auto-lock policy ─────────────────────────────────────────────────────────
 *
 *   severity 'high' or 'critical' → unit auto-locked under system authority
 *   severity 'low'  or 'medium'   → flag created; no lock applied
 *
 *   If the unit is already fraud_locked or voided, auto-lock is skipped and
 *   lock_record_id is null in the response.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * This function does NOT enforce idempotency — multiple flags of the same
 * source may exist for a unit (e.g., two independent consultant reports).
 * Callers should query existing active flags before submitting if deduplication
 * is needed for their use case.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/create-fraud-flag
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   {
 *     "unit_id":               "<uuid>",           // required
 *     "source":                "licensor_report",   // required; see sources above
 *     "severity":              "high",              // required: low | medium | high | critical
 *     "description":           "CLC audit flagged unit GTG-ABC123 as suspected counterfeit.",
 *     "related_order_id":      "<uuid>",            // required for payment_chargeback; optional otherwise
 *     "related_consultant_id": "<uuid>",            // optional; recommended for consultant/velocity signals
 *     "reporting_licensor":    "CLC",               // required for licensor_report; null otherwise
 *     "signal_metadata":       { "audit_ref": "..." } // optional; raw signal payload for investigators
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "fraud_flag_id":   "<uuid>",
 *       "unit_id":         "<uuid>",
 *       "source":          "licensor_report",
 *       "severity":        "high",
 *       "lock_record_id":  "<uuid>",   // null if no auto-lock applied
 *       "auto_locked":     true
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing required fields, invalid source/severity,
 *        missing reporting_licensor, missing related_order_id for chargeback)
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

const VALID_SOURCES = new Set([
  'hologram_scan_fail',
  'duplicate_serial',
  'duplicate_hologram',
  'consultant_report',
  'customer_report',
  'licensor_report',
  'admin_manual',
  'payment_chargeback',
  'velocity_anomaly',
])

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])

const VALID_REPORTING_LICENSORS = new Set(['CLC', 'ARMY'])

// Sources that require a specific companion field.
const SOURCES_REQUIRING_ORDER:    ReadonlySet<string> = new Set(['payment_chargeback'])
const SOURCES_REQUIRING_LICENSOR: ReadonlySet<string> = new Set(['licensor_report'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  unit_id:                string
  source:                 string
  severity:               string
  description:            string
  related_order_id?:      string
  related_consultant_id?: string
  reporting_licensor?:    string
  signal_metadata?:       Record<string, unknown>
}

interface FlagRow {
  fraud_flag_id:  string
  lock_record_id: string | null
}

interface ResponsePayload {
  fraud_flag_id:  string
  unit_id:        string
  source:         string
  severity:       string
  lock_record_id: string | null
  auto_locked:    boolean
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('create-fraud-flag', req)
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

    // unit_id
    if (!body.unit_id || !UUID_RE.test(body.unit_id)) {
      return jsonError(req, 'unit_id must be a valid UUID.', 400)
    }

    // source
    if (!body.source || !VALID_SOURCES.has(body.source)) {
      return jsonError(
        req,
        `source must be one of: ${[...VALID_SOURCES].join(', ')}.`,
        400,
      )
    }

    // severity
    if (!body.severity || !VALID_SEVERITIES.has(body.severity)) {
      return jsonError(
        req,
        `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}.`,
        400,
      )
    }

    // description
    if (!body.description || typeof body.description !== 'string' || body.description.trim() === '') {
      return jsonError(req, 'description is required.', 400)
    }

    // Source-specific: licensor_report requires reporting_licensor
    if (SOURCES_REQUIRING_LICENSOR.has(body.source)) {
      if (!body.reporting_licensor || !VALID_REPORTING_LICENSORS.has(body.reporting_licensor)) {
        return jsonError(
          req,
          `reporting_licensor is required for '${body.source}' signals. ` +
          `Must be one of: ${[...VALID_REPORTING_LICENSORS].join(', ')}.`,
          400,
        )
      }
    }

    // Source-specific: payment_chargeback requires related_order_id
    if (SOURCES_REQUIRING_ORDER.has(body.source)) {
      if (!body.related_order_id || !UUID_RE.test(body.related_order_id)) {
        return jsonError(
          req,
          `related_order_id is required for '${body.source}' signals and must be a valid UUID.`,
          400,
        )
      }
    }

    // Optional UUID fields — validate format if provided
    if (body.related_order_id !== undefined && !UUID_RE.test(body.related_order_id)) {
      return jsonError(req, 'related_order_id must be a valid UUID.', 400)
    }
    if (body.related_consultant_id !== undefined && !UUID_RE.test(body.related_consultant_id)) {
      return jsonError(req, 'related_consultant_id must be a valid UUID.', 400)
    }

    // reporting_licensor outside licensor_report: must be null (avoid data confusion)
    if (!SOURCES_REQUIRING_LICENSOR.has(body.source) && body.reporting_licensor !== undefined) {
      return jsonError(
        req,
        `reporting_licensor should only be set for 'licensor_report' signals. ` +
        `Remove it for source '${body.source}' or change the source.`,
        400,
      )
    }

    // ── Step 6: Create fraud flag ───────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Creating fraud flag', {
      unit_id:             body.unit_id,
      source:              body.source,
      severity:            body.severity,
      reporting_licensor:  body.reporting_licensor ?? null,
      has_order_context:   body.related_order_id !== undefined,
      has_consultant_context: body.related_consultant_id !== undefined,
    })

    const { data: flagRows, error: flagError } = await admin.rpc('create_fraud_flag', {
      p_unit_id:                body.unit_id,
      p_source:                 body.source,
      p_severity:               body.severity,
      p_description:            body.description,
      p_raised_by:              authorized.id,
      p_related_order_id:       body.related_order_id       ?? null,
      p_related_consultant_id:  body.related_consultant_id  ?? null,
      p_reporting_licensor:     body.reporting_licensor      ?? null,
      p_signal_metadata:        body.signal_metadata         ?? null,
    })

    if (flagError !== null) {
      const gtgMatch = flagError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('create_fraud_flag failed', {
        unit_id: body.unit_id,
        source:  body.source,
        error:   flagError.message,
      })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Failed to create fraud flag.', 400)
    }

    const flag = (flagRows as FlagRow[])[0]!
    const autoLocked = flag.lock_record_id !== null

    authedLog.info('Fraud flag created', {
      fraud_flag_id:  flag.fraud_flag_id,
      unit_id:        body.unit_id,
      source:         body.source,
      severity:       body.severity,
      auto_locked:    autoLocked,
      lock_record_id: flag.lock_record_id,
    })

    return jsonResponse(req, {
      fraud_flag_id:  flag.fraud_flag_id,
      unit_id:        body.unit_id,
      source:         body.source,
      severity:       body.severity,
      lock_record_id: flag.lock_record_id,
      auto_locked:    autoLocked,
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
