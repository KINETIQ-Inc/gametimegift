/**
 * GTG Edge Function — assign-product-license
 *
 * Admin product catalog management (4A-3).
 * Assigns or changes the license body (and optional rate override) for a product.
 * Dedicated endpoint for this compliance-significant operation — distinct from
 * the general edit-product function.
 *
 * ─── Why a dedicated endpoint ─────────────────────────────────────────────────
 *
 * Changing a product's license_body changes its royalty obligation going forward.
 * Units already received retain their stamped values (immutable). Only future
 * unit receipts are affected. This endpoint:
 *
 *   1. Validates that an active license_holder exists for the target body
 *      (CLC / ARMY). Assigning a product to a body with no active rate agreement
 *      would leave future unit receipts unable to stamp a royalty rate —
 *      a silent misconfiguration that would corrupt the royalty audit chain.
 *
 *   2. Returns the effective_rate that will be stamped on future units, along
 *      with the active license_holder summary. The admin sees the full downstream
 *      impact before any units are received.
 *
 * ─── Rate override semantics ──────────────────────────────────────────────────
 *
 *   royalty_rate = <number>   Product-level override. This rate is stamped on
 *                             future units regardless of the license_holder default.
 *
 *   royalty_rate = null       Clears any existing product-level override. Future
 *                             units will inherit the active license_holder's
 *                             default_royalty_rate at receive time.
 *
 *   royalty_rate absent       Same as null — the product override is cleared
 *                             when changing license body. To preserve an existing
 *                             override when only re-assigning the body, include
 *                             the existing rate in the request.
 *
 *   license_body = 'NONE'     royalty_rate must not be provided (no obligation).
 *                             Any existing rate override is cleared automatically.
 *
 * ─── Active license_holder requirement ───────────────────────────────────────
 *
 * For license_body = 'CLC' or 'ARMY': an active license_holder row must exist
 * (is_active = true). If none exists, the assignment is rejected with 400.
 * Create the license_holder record first.
 *
 * For license_body = 'NONE': no license_holder lookup is performed.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/assign-product-license
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "product_id":    "<uuid>",
 *     "license_body":  "CLC",
 *     "royalty_rate":  0.145     // optional; null or absent to use holder default
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "product_id":     "<uuid>",
 *       "sku":            "APP-NIKE-JERSEY-M",
 *       "license_body":   "CLC",
 *       "royalty_rate":   0.145,        // product override (null = none set)
 *       "effective_rate": 0.145,        // rate stamped on future units
 *       "license_holder": {             // null when license_body = 'NONE'
 *         "id":                    "<uuid>",
 *         "legal_name":            "Collegiate Licensing Company",
 *         "code":                  "CLC-001",
 *         "default_royalty_rate":  0.14,
 *         "minimum_royalty_cents": 50000,
 *         "reporting_period":      "quarterly"
 *       }
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Product not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE              = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_LICENSE_BODIES = new Set(['CLC', 'ARMY', 'NONE'])
const LICENSED_BODIES      = new Set(['CLC', 'ARMY'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  product_id:    string
  license_body:  string
  royalty_rate?: number | null
}

interface ExistingProduct {
  id:           string
  sku:          string
  license_body: string
  royalty_rate: number | null
  is_active:    boolean
}

interface ActiveHolder {
  id:                    string
  legal_name:            string
  code:                  string
  default_royalty_rate:  number
  minimum_royalty_cents: number | null
  reporting_period:      string
}

interface AssignLicenseResponse {
  product_id:     string
  sku:            string
  license_body:   string
  royalty_rate:   number | null
  effective_rate: number | null
  license_holder: ActiveHolder | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('assign-product-license', req)
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

    if (!body.product_id || !UUID_RE.test(body.product_id)) {
      return jsonError(req, 'product_id must be a valid UUID.', 400)
    }

    if (!body.license_body || !VALID_LICENSE_BODIES.has(body.license_body)) {
      return jsonError(req, "license_body must be one of: 'CLC', 'ARMY', 'NONE'.", 400)
    }

    // royalty_rate: must not be provided at all when targeting NONE
    if (body.license_body === 'NONE' && body.royalty_rate != null) {
      return jsonError(
        req,
        "royalty_rate must not be provided when license_body is 'NONE'. " +
        'Unlicensed products carry no royalty obligation.',
        400,
      )
    }

    if (body.royalty_rate != null) {
      if (typeof body.royalty_rate !== 'number' || !isFinite(body.royalty_rate)) {
        return jsonError(req, 'royalty_rate must be a finite number or null.', 400)
      }
      if (body.royalty_rate <= 0 || body.royalty_rate > 1) {
        return jsonError(
          req,
          'royalty_rate must be greater than 0 and at most 1 (e.g. 0.145 for 14.5%).',
          400,
        )
      }
    }

    // ── Step 6: Pre-flight — fetch product ──────────────────────────────────────

    const admin = createAdminClient()

    const { data: productRow, error: productError } = await admin
      .from('products')
      .select('id, sku, license_body, royalty_rate, is_active')
      .eq('id', body.product_id)
      .single()

    if (productError !== null || productRow === null) {
      authedLog.warn('Product not found', { product_id: body.product_id })
      return jsonError(req, `Product '${body.product_id}' not found.`, 404)
    }

    const current = productRow as ExistingProduct

    // ── Step 7: Fetch active license_holder (required for licensed bodies) ──────

    let activeHolder: ActiveHolder | null = null

    if (LICENSED_BODIES.has(body.license_body)) {
      const { data: holderRow, error: holderError } = await admin
        .from('license_holders')
        .select(
          'id, legal_name, code, default_royalty_rate, minimum_royalty_cents, reporting_period',
        )
        .eq('license_body', body.license_body)
        .eq('is_active', true)
        .single()

      if (holderError !== null || holderRow === null) {
        authedLog.warn('No active license_holder for body', { license_body: body.license_body })
        return jsonError(
          req,
          `No active license_holder exists for license_body '${body.license_body}'. ` +
          'Create a license_holder record for this body before assigning products to it. ' +
          'Without an active holder, future unit receipts cannot stamp a royalty rate.',
          400,
        )
      }

      activeHolder = holderRow as ActiveHolder
    }

    // ── Step 8: Resolve the royalty_rate to write ───────────────────────────────

    // royalty_rate in the update:
    //   - body.royalty_rate provided (number)  → use it
    //   - body.royalty_rate = null or absent + target is NONE → clear to null
    //   - body.royalty_rate = null or absent + target is CLC/ARMY → clear to null
    //     (admin must explicitly include the value to preserve an override when
    //     changing bodies; absent = intent to use holder default going forward)
    const rateToWrite: number | null = body.royalty_rate ?? null

    // ── Step 9: Update product ──────────────────────────────────────────────────

    authedLog.info('Assigning license', {
      product_id:        body.product_id,
      sku:               current.sku,
      from_license_body: current.license_body,
      to_license_body:   body.license_body,
      from_royalty_rate: current.royalty_rate,
      to_royalty_rate:   rateToWrite,
    })

    const { data: updated, error: updateError } = await admin
      .from('products')
      .update({
        license_body: body.license_body,
        royalty_rate: rateToWrite,
      })
      .eq('id', body.product_id)
      .select('id, sku, license_body, royalty_rate')
      .single()

    if (updateError !== null) {
      const gtgMatch = updateError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('License assignment failed', { error: updateError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    // ── Step 10: Derive effective_rate ──────────────────────────────────────────
    //
    // effective_rate = the rate that will be stamped on future units at receive time:
    //   - If the product has a royalty_rate override → that rate
    //   - If no override + licensed body → license_holder.default_royalty_rate
    //   - If NONE → null (no royalty obligation)

    const effectiveRate: number | null =
      updated.royalty_rate  ??
      activeHolder?.default_royalty_rate ??
      null

    authedLog.info('License assigned', {
      product_id:     updated.id,
      sku:            updated.sku,
      license_body:   updated.license_body,
      royalty_rate:   updated.royalty_rate,
      effective_rate: effectiveRate,
    })

    const payload: AssignLicenseResponse = {
      product_id:     updated.id,
      sku:            updated.sku,
      license_body:   updated.license_body,
      royalty_rate:   updated.royalty_rate,
      effective_rate: effectiveRate,
      license_holder: activeHolder,
    }

    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
