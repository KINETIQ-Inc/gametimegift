/**
 * GTG Edge Function — get-unit-status
 *
 * Authenticated unit status display for consultants and admins (5C-2).
 * Returns the full lifecycle details of a serialized unit, with role-scoped
 * field visibility. Complements the public verify-serial endpoint (5C-1) by
 * providing internal operational detail to authorised callers.
 *
 * ─── Role scoping ─────────────────────────────────────────────────────────────
 *
 *   admin / super_admin
 *     Can look up any unit. Receives full detail including internal fields:
 *     cost_cents, retail_price_cents, fraud_lock_reason, fraud_locked_at,
 *     fraud_locked_by, consultant_id.
 *
 *   consultant
 *     Can only look up units where the unit's consultant_id matches their own
 *     consultant profile. Attempting to look up another consultant's unit or a
 *     direct-sale unit returns 404 (no information leak about existence).
 *     Internal financial and fraud fields are excluded from the response.
 *
 * ─── Input ────────────────────────────────────────────────────────────────────
 *
 * Provide exactly one of:
 *
 *   serial_number   Physical serial number (case-insensitive, whitespace trimmed).
 *   unit_id         UUID of the serialized_units row.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * Requires a valid JWT. Allowed roles: admin, super_admin, consultant.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-unit-status
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   By serial number:
 *   { "serial_number": "GTG-CLC-2026-0001" }
 *
 *   By unit ID:
 *   { "unit_id": "<uuid>" }
 *
 * ─── Response (admin) ─────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "unit_id":             "<uuid>",
 *       "serial_number":       "GTG-CLC-2026-0001",
 *       "sku":                 "APP-NIKE-JERSEY-M",
 *       "product_id":          "<uuid>",
 *       "product_name":        "Nike Jersey — Medium",
 *       "product_description": "...",
 *       "license_body":        "CLC",
 *       "royalty_rate":        0.145,
 *       "status":              "sold",
 *       "hologram":            { ... },
 *       "cost_cents":          2500,
 *       "retail_price_cents":  4999,
 *       "order_id":            "<uuid>",
 *       "consultant_id":       "<uuid>",
 *       "received_at":         "2026-01-15T10:00:00Z",
 *       "sold_at":             "2026-03-05T14:22:11Z",
 *       "returned_at":         null,
 *       "fraud_locked_at":     null,
 *       "fraud_locked_by":     null,
 *       "fraud_lock_reason":   null,
 *       "updated_at":          "2026-03-05T14:22:11Z"
 *     }
 *   }
 *
 * ─── Response (consultant) ────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "unit_id":             "<uuid>",
 *       "serial_number":       "GTG-CLC-2026-0001",
 *       "sku":                 "APP-NIKE-JERSEY-M",
 *       "product_id":          "<uuid>",
 *       "product_name":        "Nike Jersey — Medium",
 *       "product_description": "...",
 *       "license_body":        "CLC",
 *       "royalty_rate":        0.145,
 *       "status":              "sold",
 *       "hologram":            { ... },
 *       "order_id":            "<uuid>",
 *       "received_at":         "2026-01-15T10:00:00Z",
 *       "sold_at":             "2026-03-05T14:22:11Z",
 *       "returned_at":         null,
 *       "updated_at":          "2026-03-05T14:22:11Z"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (missing lookup key, invalid UUID format, etc.)
 *   401  Unauthenticated
 *   403  Forbidden (role not permitted)
 *   404  Unit not found, or consultant lacks visibility to the requested unit
 *   500  Internal server error
 */

import { ADMIN_ROLES, extractRole, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE           = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SERIAL_LENGTH = 100

const ALLOWED_ROLES = new Set(['super_admin', 'admin', 'consultant'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  serial_number?: unknown
  unit_id?:       unknown
}

interface UnitRow {
  id:                 string
  serial_number:      string
  sku:                string
  product_id:         string
  product_name:       string
  license_body:       string
  royalty_rate:       number
  status:             string
  hologram:           unknown
  cost_cents:         number
  retail_price_cents: number | null
  order_id:           string | null
  consultant_id:      string | null
  received_at:        string
  sold_at:            string | null
  returned_at:        string | null
  fraud_locked_at:    string | null
  fraud_locked_by:    string | null
  fraud_lock_reason:  string | null
  updated_at:         string
  products: {
    description: string | null
  } | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('get-unit-status', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ───────────────────────────────────────────────────

    const role = extractRole(user)

    if (role === null || !ALLOWED_ROLES.has(role)) {
      log.warn('Forbidden role', { user_id: user.id, role })
      const { denied } = verifyRole(user, [...ADMIN_ROLES, 'consultant'], req)
      return denied!
    }

    const isAdmin = role === 'admin' || role === 'super_admin'
    const authedLog = log.withUser(user.id)
    authedLog.info('Authenticated', { role })

    // ── Step 5: Parse and validate request body ─────────────────────────────

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    const hasSerialNumber = body.serial_number !== undefined && body.serial_number !== null
    const hasUnitId       = body.unit_id !== undefined && body.unit_id !== null

    if (!hasSerialNumber && !hasUnitId) {
      return jsonError(req, 'Provide either serial_number or unit_id.', 400)
    }

    if (hasSerialNumber && hasUnitId) {
      return jsonError(req, 'Provide either serial_number or unit_id, not both.', 400)
    }

    let serialFilter:   string | null = null
    let unitIdFilter:   string | null = null

    if (hasSerialNumber) {
      if (typeof body.serial_number !== 'string') {
        return jsonError(req, 'serial_number must be a string.', 400)
      }
      const trimmed = body.serial_number.trim().toUpperCase()
      if (trimmed.length === 0) {
        return jsonError(req, 'serial_number must not be empty.', 400)
      }
      if (trimmed.length > MAX_SERIAL_LENGTH) {
        return jsonError(
          req,
          `serial_number must be at most ${MAX_SERIAL_LENGTH} characters.`,
          400,
        )
      }
      serialFilter = trimmed
    } else {
      if (typeof body.unit_id !== 'string' || !UUID_RE.test(body.unit_id)) {
        return jsonError(req, 'unit_id must be a valid UUID.', 400)
      }
      unitIdFilter = body.unit_id
    }

    authedLog.info('Looking up unit', {
      by: serialFilter ? 'serial_number' : 'unit_id',
      value: serialFilter ?? unitIdFilter,
    })

    // ── Step 6: Look up the unit ────────────────────────────────────────────
    //
    // Admin client used for all lookups — bypasses RLS so admins can retrieve
    // any unit and consultants can verify sold units (not just available ones).
    // Application-level authorization (step 7) enforces consultant scoping.

    const admin = createAdminClient()

    let query = admin
      .from('serialized_units')
      .select(`
        id,
        serial_number,
        sku,
        product_id,
        product_name,
        license_body,
        royalty_rate,
        status,
        hologram,
        cost_cents,
        retail_price_cents,
        order_id,
        consultant_id,
        received_at,
        sold_at,
        returned_at,
        fraud_locked_at,
        fraud_locked_by,
        fraud_lock_reason,
        updated_at,
        products ( description )
      `)

    query = serialFilter !== null
      ? query.eq('serial_number', serialFilter)
      : query.eq('id', unitIdFilter!)

    const { data, error: unitError } = await query.maybeSingle()

    if (unitError !== null) {
      authedLog.error('Unit lookup failed', { error: unitError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (data === null) {
      authedLog.info('Unit not found', {
        serial_number: serialFilter,
        unit_id:       unitIdFilter,
      })
      return jsonError(req, 'Unit not found.', 404)
    }

    const unit = data as UnitRow

    // ── Step 7: Consultant visibility gate ──────────────────────────────────
    //
    // Consultants may only view units linked to their own sales. A consultant
    // who guesses another unit's serial number receives 404 (not 403) so as
    // not to confirm that the unit exists in the system.
    //
    // Look up the consultant's profile ID first, then compare against the
    // unit's consultant_id. The comparison is against consultant_profiles.id
    // (not auth.uid()), since serialized_units.consultant_id references the
    // profile row, not the auth user row.

    if (!isAdmin) {
      const { data: profile, error: profileError } = await admin
        .from('consultant_profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (profileError !== null || profile === null) {
        authedLog.warn('Consultant profile not found', { error: profileError?.message })
        return jsonError(req, 'Unit not found.', 404)
      }

      if (unit.consultant_id !== profile.id) {
        authedLog.warn('Consultant attempted to view unit not linked to their profile', {
          unit_id:               unit.id,
          unit_consultant_id:    unit.consultant_id,
          caller_consultant_id:  profile.id,
        })
        return jsonError(req, 'Unit not found.', 404)
      }
    }

    // ── Step 8: Build role-scoped response ──────────────────────────────────
    //
    // Admins receive all fields. Consultants receive the operational fields
    // needed to track their sales; internal financial and fraud details are
    // excluded. This is enforced at the response layer, not by SQL projection,
    // so that the same DB query can serve both roles without duplication.

    const productDescription = unit.products?.description ?? null

    authedLog.info('Unit status retrieved', {
      unit_id:      unit.id,
      status:       unit.status,
      license_body: unit.license_body,
    })

    if (isAdmin) {
      return jsonResponse(req, {
        unit_id:             unit.id,
        serial_number:       unit.serial_number,
        sku:                 unit.sku,
        product_id:          unit.product_id,
        product_name:        unit.product_name,
        product_description: productDescription,
        license_body:        unit.license_body,
        royalty_rate:        unit.royalty_rate,
        status:              unit.status,
        hologram:            unit.hologram ?? null,
        cost_cents:          unit.cost_cents,
        retail_price_cents:  unit.retail_price_cents ?? null,
        order_id:            unit.order_id ?? null,
        consultant_id:       unit.consultant_id ?? null,
        received_at:         unit.received_at,
        sold_at:             unit.sold_at ?? null,
        returned_at:         unit.returned_at ?? null,
        fraud_locked_at:     unit.fraud_locked_at ?? null,
        fraud_locked_by:     unit.fraud_locked_by ?? null,
        fraud_lock_reason:   unit.fraud_lock_reason ?? null,
        updated_at:          unit.updated_at,
      })
    }

    // Consultant-scoped response — no financial internals, no fraud details.
    return jsonResponse(req, {
      unit_id:             unit.id,
      serial_number:       unit.serial_number,
      sku:                 unit.sku,
      product_id:          unit.product_id,
      product_name:        unit.product_name,
      product_description: productDescription,
      license_body:        unit.license_body,
      royalty_rate:        unit.royalty_rate,
      status:              unit.status,
      hologram:            unit.hologram ?? null,
      order_id:            unit.order_id ?? null,
      received_at:         unit.received_at,
      sold_at:             unit.sold_at ?? null,
      returned_at:         unit.returned_at ?? null,
      updated_at:          unit.updated_at,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
