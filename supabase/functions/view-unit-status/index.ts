/**
 * GTG Edge Function — view-unit-status
 *
 * Serialized unit status inspection (4B-2).
 * Read-only — no writes. Supports two query modes:
 *
 *   Single-unit lookup  — by unit_id (UUID) or serial_number
 *   Filtered list       — by any combination of batch_id, product_id, status,
 *                         with limit/offset pagination
 *
 * ─── Query modes ──────────────────────────────────────────────────────────────
 *
 * Single-unit mode (unit_id or serial_number present):
 *   Returns the full unit record + batch context. Returns 404 if not found.
 *   Including both unit_id and serial_number in the same request is rejected.
 *
 * List mode (no unit_id or serial_number):
 *   Returns a paginated array of units. Filters may be combined freely.
 *   No filter = full inventory scan (paginated; use filters for large catalogs).
 *   Results are ordered by received_at descending (most recent first).
 *
 * ─── Response fields ──────────────────────────────────────────────────────────
 *
 * Each unit includes:
 *   Core identity:   id, serial_number, sku, product_id, product_name, batch_id
 *   Lifecycle:       status, received_at, sold_at, returned_at, updated_at
 *   Licensing:       license_body, royalty_rate
 *   Pricing:         cost_cents, retail_price_cents (null until sold)
 *   Linkage:         order_id (null until sold), consultant_id (null for direct sales)
 *   Hologram:        hologram (JSONB snapshot, null until applied)
 *   Fraud lock:      fraud_locked_at, fraud_locked_by, fraud_lock_reason
 *                    (all null unless status = 'fraud_locked')
 *   Batch context:   batch.batch_number, batch.purchase_order_number,
 *                    batch.expected_unit_count, batch.received_unit_count
 *                    (null when batch_id is null)
 *
 * ─── Status values ────────────────────────────────────────────────────────────
 *
 *   available    in stock, not reserved
 *   reserved     temporarily held during checkout
 *   sold         ownership transferred
 *   fraud_locked under investigation; cannot be sold or returned
 *   returned     returned by customer
 *   voided       permanently removed from inventory
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Unit records contain fraud lock details and financial linkage — admin only.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/view-unit-status
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   Single-unit by ID:
 *   { "unit_id": "<uuid>" }
 *
 *   Single-unit by serial number:
 *   { "serial_number": "GTG-CLC-2026-0001" }
 *
 *   Filtered list (all filters optional, combinable):
 *   {
 *     "batch_id":   "<uuid>",
 *     "product_id": "<uuid>",
 *     "status":     "fraud_locked",
 *     "limit":      50,
 *     "offset":     0
 *   }
 *
 * ─── Response — single unit ───────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "id":                 "<uuid>",
 *       "serial_number":      "GTG-CLC-2026-0001",
 *       "sku":                "APP-NIKE-JERSEY-M",
 *       "product_id":         "<uuid>",
 *       "product_name":       "Nike Jersey — Medium",
 *       "batch_id":           "<uuid>",
 *       "status":             "available",
 *       "license_body":       "CLC",
 *       "royalty_rate":       0.145,
 *       "cost_cents":         2499,
 *       "retail_price_cents": null,
 *       "order_id":           null,
 *       "consultant_id":      null,
 *       "hologram":           null,
 *       "received_at":        "2026-03-06T...",
 *       "sold_at":            null,
 *       "returned_at":        null,
 *       "fraud_locked_at":    null,
 *       "fraud_locked_by":    null,
 *       "fraud_lock_reason":  null,
 *       "updated_at":         "2026-03-06T...",
 *       "batch": {
 *         "batch_number":          "BATCH-20260306-CLC-001",
 *         "purchase_order_number": "PO-2026-0042",
 *         "expected_unit_count":   100,
 *         "received_unit_count":   97
 *       }
 *     }
 *   }
 *
 * ─── Response — list ──────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "units":  [...],
 *       "total":  97,
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
 *   404  Unit not found (single-unit mode only)
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VALID_STATUSES = new Set([
  'available', 'reserved', 'sold', 'fraud_locked', 'returned', 'voided',
])

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 200

// Supabase join selector for manufacturing_batches via batch_id FK
const UNIT_SELECT = `
  *,
  batch:manufacturing_batches!batch_id (
    batch_number,
    purchase_order_number,
    expected_unit_count,
    received_unit_count
  )
`.trim()

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  // Single-unit mode (mutually exclusive)
  unit_id?:      string
  serial_number?: string

  // List mode filters (all optional)
  batch_id?:   string
  product_id?: string
  status?:     string

  // Pagination (list mode only)
  limit?:  number
  offset?: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('view-unit-status', req)
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

    // ── Step 6: Determine mode and validate ─────────────────────────────────────

    const hasSingleById     = body.unit_id      !== undefined
    const hasSingleBySerial = body.serial_number !== undefined

    // Mutual exclusion: unit_id and serial_number cannot both be present
    if (hasSingleById && hasSingleBySerial) {
      return jsonError(
        req,
        "Provide either 'unit_id' or 'serial_number', not both.",
        400,
      )
    }

    const admin = createAdminClient()

    // ── Single-unit mode ─────────────────────────────────────────────────────────

    if (hasSingleById || hasSingleBySerial) {

      // Validate the lookup key
      if (hasSingleById) {
        if (!body.unit_id || !UUID_RE.test(body.unit_id)) {
          return jsonError(req, 'unit_id must be a valid UUID.', 400)
        }
      } else {
        if (!body.serial_number || typeof body.serial_number !== 'string' ||
            body.serial_number.trim().length === 0) {
          return jsonError(req, 'serial_number must be a non-empty string.', 400)
        }
      }

      const lookup = hasSingleById
        ? { column: 'id',            value: body.unit_id! }
        : { column: 'serial_number', value: body.serial_number!.trim() }

      authedLog.info('Single-unit lookup', {
        mode:  hasSingleById ? 'by_id' : 'by_serial',
        value: lookup.value,
      })

      const { data: unit, error: queryError } = await admin
        .from('serialized_units')
        .select(UNIT_SELECT)
        .eq(lookup.column, lookup.value)
        .single()

      if (queryError !== null) {
        // PGRST116 = no rows returned (PostgREST .single() 404 signal)
        if (queryError.code === 'PGRST116') {
          authedLog.warn('Unit not found', { [lookup.column]: lookup.value })
          return jsonError(
            req,
            hasSingleById
              ? `Unit '${body.unit_id}' not found.`
              : `No unit found with serial_number '${body.serial_number}'.`,
            404,
          )
        }
        authedLog.error('Unit query failed', { error: queryError.message })
        return jsonError(req, 'Internal server error', 500)
      }

      authedLog.info('Unit found', {
        unit_id:       unit.id,
        serial_number: unit.serial_number,
        status:        unit.status,
      })

      return jsonResponse(req, unit)
    }

    // ── List mode ────────────────────────────────────────────────────────────────

    // Validate list filters
    if (body.batch_id !== undefined) {
      if (!UUID_RE.test(body.batch_id)) {
        return jsonError(req, 'batch_id must be a valid UUID.', 400)
      }
    }

    if (body.product_id !== undefined) {
      if (!UUID_RE.test(body.product_id)) {
        return jsonError(req, 'product_id must be a valid UUID.', 400)
      }
    }

    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status)) {
        return jsonError(
          req,
          `status must be one of: ${[...VALID_STATUSES].join(', ')}.`,
          400,
        )
      }
    }

    // Pagination
    let limit = DEFAULT_LIMIT
    let offset = 0

    if (body.limit !== undefined) {
      if (!Number.isInteger(body.limit) || body.limit < 1) {
        return jsonError(req, 'limit must be a positive integer.', 400)
      }
      if (body.limit > MAX_LIMIT) {
        return jsonError(req, `limit must be at most ${MAX_LIMIT}.`, 400)
      }
      limit = body.limit
    }

    if (body.offset !== undefined) {
      if (!Number.isInteger(body.offset) || body.offset < 0) {
        return jsonError(req, 'offset must be a non-negative integer.', 400)
      }
      offset = body.offset
    }

    authedLog.info('List query', {
      batch_id:   body.batch_id,
      product_id: body.product_id,
      status:     body.status,
      limit,
      offset,
    })

    // Build query with filters
    let query = admin
      .from('serialized_units')
      .select(UNIT_SELECT, { count: 'exact' })
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (body.batch_id   !== undefined) query = query.eq('batch_id',   body.batch_id)
    if (body.product_id !== undefined) query = query.eq('product_id', body.product_id)
    if (body.status     !== undefined) query = query.eq('status',     body.status)

    const { data: units, count, error: queryError } = await query

    if (queryError !== null) {
      authedLog.error('Unit list query failed', { error: queryError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('List query complete', {
      returned: units?.length ?? 0,
      total:    count,
      offset,
      limit,
    })

    return jsonResponse(req, {
      units:  units ?? [],
      total:  count ?? 0,
      limit,
      offset,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
