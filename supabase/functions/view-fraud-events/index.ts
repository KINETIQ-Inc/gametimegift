/**
 * GTG Edge Function — view-fraud-events
 *
 * Paginated, filterable list of fraud flag investigation records (4E-1).
 * Read-only — no writes. Supports the admin fraud investigation queue with
 * multi-dimensional filtering across status, severity, source, unit, and
 * investigator assignment.
 *
 * ─── Filters ──────────────────────────────────────────────────────────────────
 *
 * All filters are optional and combinable. Omitting all filters returns the
 * full fraud flag history, newest first.
 *
 *   status        One status string or array of statuses. Statuses:
 *                   open          Signal received; not yet assigned
 *                   under_review  Assigned; investigation in progress
 *                   escalated     Elevated to senior authority or licensor
 *                   confirmed     Fraud verified; lock applied or in force
 *                   dismissed     False positive; no action taken
 *
 *   severity      One severity string or array of severities. Severities:
 *                   low       Reviewed in next scheduled audit cycle; no auto-lock
 *                   medium    7-day SLA; no auto-lock
 *                   high      72-hour SLA; unit auto-locked on creation
 *                   critical  24-hour SLA; unit auto-locked on creation
 *
 *   source        One signal source. Sources:
 *                   hologram_scan_fail, duplicate_serial, duplicate_hologram,
 *                   consultant_report, customer_report, licensor_report,
 *                   admin_manual, payment_chargeback, velocity_anomaly
 *
 *   unit_id       UUID — all flags for a specific serialized unit.
 *
 *   assigned_to   UUID — all flags assigned to a specific investigator.
 *
 *   auto_locked   Boolean — true: only flags that triggered an auto-lock;
 *                           false: only flags that did not.
 *
 * ─── Ordering ─────────────────────────────────────────────────────────────────
 *
 * Default: created_at DESC (most recently raised first).
 * The investigation queue typically sorts this way to surface new signals.
 * Use severity + status filters to narrow to the priority queue
 * (e.g. status = ["open","under_review","escalated"], severity = ["critical","high"]).
 *
 * ─── Pagination ───────────────────────────────────────────────────────────────
 *
 * limit   Default 50, max 200.
 * offset  Default 0.
 * total   Exact row count returned alongside each page.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Fraud records include fraud signal detail and investigation notes.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/view-fraud-events
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   All filters optional:
 *   {
 *     "status":      ["open", "under_review", "escalated"],
 *     "severity":    ["critical", "high"],
 *     "source":      "duplicate_serial",
 *     "unit_id":     "<uuid>",
 *     "assigned_to": "<uuid>",
 *     "auto_locked": true,
 *     "limit":       50,
 *     "offset":      0
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "flags": [
 *         {
 *           "id":                    "<uuid>",
 *           "unit_id":               "<uuid>",
 *           "serial_number":         "GTG-CLC-2026-0001",
 *           "sku":                   "APP-NIKE-JERSEY-M",
 *           "source":                "duplicate_serial",
 *           "severity":              "high",
 *           "status":                "under_review",
 *           "unit_status_at_flag":   "sold",
 *           "auto_locked":           true,
 *           "auto_lock_id":          "<uuid>",
 *           "related_order_id":      "<uuid>",
 *           "related_consultant_id": null,
 *           "reporting_licensor":    null,
 *           "signal_metadata":       { ... },
 *           "description":           "Duplicate serial on order ORD-2026-0042.",
 *           "raised_by":             "<uuid>",
 *           "assigned_to":           "<uuid>",
 *           "assigned_at":           "2026-03-05T...",
 *           "investigation_notes":   "Confirmed two orders reference same serial.",
 *           "escalation_reason":     null,
 *           "resolution_note":       null,
 *           "resolved_at":           null,
 *           "resolved_by":           null,
 *           "created_at":            "2026-03-04T...",
 *           "updated_at":            "2026-03-05T..."
 *         }
 *       ],
 *       "total":  142,
 *       "limit":  50,
 *       "offset": 0
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
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

const VALID_STATUSES: Set<string> = new Set([
  'open', 'under_review', 'escalated', 'confirmed', 'dismissed',
])

const VALID_SEVERITIES: Set<string> = new Set([
  'low', 'medium', 'high', 'critical',
])

const VALID_SOURCES: Set<string> = new Set([
  'hologram_scan_fail', 'duplicate_serial', 'duplicate_hologram',
  'consultant_report', 'customer_report', 'licensor_report',
  'admin_manual', 'payment_chargeback', 'velocity_anomaly',
])

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  status?:      string | string[]
  severity?:    string | string[]
  source?:      string
  unit_id?:     string
  assigned_to?: string
  auto_locked?: boolean
  limit?:       number
  offset?:      number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise a filter value that may be a string or string[] into a string[]. */
function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('view-fraud-events', req)
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

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    // ── Validate status filter ──

    if (body.status !== undefined) {
      const statuses = toArray(body.status as string | string[])
      if (statuses.length === 0) {
        return jsonError(req, 'status must be a non-empty string or array.', 400)
      }
      const invalid = statuses.filter((s) => !VALID_STATUSES.has(s))
      if (invalid.length > 0) {
        return jsonError(
          req,
          `Invalid status value(s): ${invalid.join(', ')}. ` +
          `Valid statuses: ${[...VALID_STATUSES].join(', ')}.`,
          400,
        )
      }
    }

    // ── Validate severity filter ──

    if (body.severity !== undefined) {
      const severities = toArray(body.severity as string | string[])
      if (severities.length === 0) {
        return jsonError(req, 'severity must be a non-empty string or array.', 400)
      }
      const invalid = severities.filter((s) => !VALID_SEVERITIES.has(s))
      if (invalid.length > 0) {
        return jsonError(
          req,
          `Invalid severity value(s): ${invalid.join(', ')}. ` +
          `Valid severities: ${[...VALID_SEVERITIES].join(', ')}.`,
          400,
        )
      }
    }

    // ── Validate source filter ──

    if (body.source !== undefined) {
      if (typeof body.source !== 'string' || !VALID_SOURCES.has(body.source)) {
        return jsonError(
          req,
          `Invalid source '${body.source}'. ` +
          `Valid sources: ${[...VALID_SOURCES].join(', ')}.`,
          400,
        )
      }
    }

    // ── Validate unit_id filter ──

    if (body.unit_id !== undefined && !UUID_RE.test(body.unit_id)) {
      return jsonError(req, 'unit_id must be a valid UUID.', 400)
    }

    // ── Validate assigned_to filter ──

    if (body.assigned_to !== undefined && !UUID_RE.test(body.assigned_to)) {
      return jsonError(req, 'assigned_to must be a valid UUID.', 400)
    }

    // ── Validate auto_locked filter ──

    if (body.auto_locked !== undefined && typeof body.auto_locked !== 'boolean') {
      return jsonError(req, 'auto_locked must be a boolean.', 400)
    }

    // ── Validate pagination ──

    const limit = body.limit ?? DEFAULT_LIMIT
    const offset = body.offset ?? 0

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return jsonError(
        req,
        `limit must be an integer between 1 and ${MAX_LIMIT}. Default is ${DEFAULT_LIMIT}.`,
        400,
      )
    }

    if (!Number.isInteger(offset) || offset < 0) {
      return jsonError(req, 'offset must be a non-negative integer.', 400)
    }

    // ── Step 6: Build and execute query ────────────────────────────────────────

    authedLog.info('Querying fraud flags', {
      status:      body.status,
      severity:    body.severity,
      source:      body.source,
      unit_id:     body.unit_id,
      assigned_to: body.assigned_to,
      auto_locked: body.auto_locked,
      limit,
      offset,
    })

    let query = createAdminClient()
      .from('fraud_flags')
      .select(
        'id, unit_id, serial_number, sku, ' +
        'source, severity, status, unit_status_at_flag, ' +
        'auto_locked, auto_lock_id, ' +
        'related_order_id, related_consultant_id, reporting_licensor, ' +
        'signal_metadata, description, ' +
        'raised_by, assigned_to, assigned_at, ' +
        'investigation_notes, escalation_reason, ' +
        'resolution_note, resolved_at, resolved_by, ' +
        'created_at, updated_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    // Apply filters
    if (body.status !== undefined) {
      const statuses = toArray(body.status as string | string[])
      query = statuses.length === 1
        ? query.eq('status', statuses[0])
        : query.in('status', statuses)
    }

    if (body.severity !== undefined) {
      const severities = toArray(body.severity as string | string[])
      query = severities.length === 1
        ? query.eq('severity', severities[0])
        : query.in('severity', severities)
    }

    if (body.source !== undefined) {
      query = query.eq('source', body.source)
    }

    if (body.unit_id !== undefined) {
      query = query.eq('unit_id', body.unit_id)
    }

    if (body.assigned_to !== undefined) {
      query = query.eq('assigned_to', body.assigned_to)
    }

    if (body.auto_locked !== undefined) {
      query = query.eq('auto_locked', body.auto_locked)
    }

    const { data: flags, error: queryError, count } = await query

    // ── Step 7: Handle errors and return ───────────────────────────────────────

    if (queryError !== null) {
      authedLog.error('Fraud flags query failed', { error: queryError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const total = count ?? 0

    authedLog.info('Fraud flags returned', {
      count:  flags?.length ?? 0,
      total,
      offset,
      limit,
    })

    return jsonResponse(req, {
      flags:  flags ?? [],
      total,
      limit,
      offset,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
