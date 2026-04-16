/**
 * GTG Edge Function — create-product
 *
 * Admin product catalog management (4A-1).
 * Creates a new product in the catalog. SKU is immutable after creation —
 * it is the stable business key denormalized across units, ledger entries,
 * commission records, and order lines.
 *
 * ─── SKU rules ────────────────────────────────────────────────────────────────
 *
 * SKU must be uppercase alphanumeric with hyphens: ^[A-Z0-9][A-Z0-9-]{2,49}$
 * (3–50 characters, starting with a letter or digit). Examples:
 *   APP-NIKE-JERSEY-M    apparel, Nike, jersey, medium
 *   ACC-ARMY-KEYCHAIN    accessory, Army, keychain
 *   CLC-HAT-COTTON-L     CLC-licensed hat, cotton, large
 *
 * SKU uniqueness is global — inactive product SKUs may not be reused.
 *
 * ─── Royalty rate semantics ───────────────────────────────────────────────────
 *
 * royalty_rate is optional. When omitted:
 *   - license_body = 'CLC' or 'ARMY': the active license_holder's
 *     default_royalty_rate is stamped onto each unit at receive time.
 *   - license_body = 'NONE': no royalty applies; rate is irrelevant.
 *
 * When provided, royalty_rate overrides the license_holder default for this
 * specific product. The rate is stamped onto units at receive time and is
 * never retroactively changed even if the product's rate changes later.
 *
 * royalty_rate must NOT be provided when license_body = 'NONE' — no royalty
 * obligation exists for unlicensed products.
 *
 * ─── Pricing rules ────────────────────────────────────────────────────────────
 *
 * cost_cents:         wholesale cost, must be > 0 (use nominal amount for comps)
 * retail_price_cents: default sell price, must be > 0 and >= cost_cents
 *
 * The retail price on the product is the default. Order lines capture the
 * actual sale price, which governs royalty and commission calculations.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/create-product
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "sku":                "APP-NIKE-JERSEY-M",
 *     "name":               "Nike Jersey — Medium",
 *     "description":        "Official licensed Nike jersey, medium fit.",  // optional
 *     "school":             "University of Florida",                        // optional
 *     "license_body":       "CLC",
 *     "royalty_rate":       0.145,                                         // optional
 *     "cost_cents":         2499,
 *     "retail_price_cents": 4999
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   201 {
 *     "data": {
 *       "id":                 "<uuid>",
 *       "sku":                "APP-NIKE-JERSEY-M",
 *       "name":               "Nike Jersey — Medium",
 *       "description":        "Official licensed Nike jersey, medium fit.",
 *       "school":             "University of Florida",
 *       "license_body":       "CLC",
 *       "royalty_rate":       0.145,
 *       "cost_cents":         2499,
 *       "retail_price_cents": 4999,
 *       "is_active":          true,
 *       "created_at":         "2026-03-06T...",
 *       "updated_at":         "2026-03-06T...",
 *       "created_by":         "<uuid>"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message for which field)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   409  SKU already exists
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

// Mirrors products_sku_format DB constraint: uppercase alphanumeric + hyphens,
// must start with letter or digit, 3–50 characters total.
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{2,49}$/

const VALID_LICENSE_BODIES = new Set(['CLC', 'ARMY', 'NONE'])

// PostgreSQL unique_violation error code
const PG_UNIQUE_VIOLATION = '23505'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  sku:                string
  name:               string
  description?:       string
  school?:            string
  license_body:       string
  royalty_rate?:      number
  cost_cents:         number
  retail_price_cents: number
}

interface Product {
  id:                 string
  sku:                string
  name:               string
  description:        string | null
  school:             string | null
  license_body:       string
  royalty_rate:       number | null
  cost_cents:         number
  retail_price_cents: number
  is_active:          boolean
  created_at:         string
  updated_at:         string
  created_by:         string
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(body: RequestBody): string | null {
  // sku
  if (!body.sku || typeof body.sku !== 'string') {
    return 'sku is required.'
  }
  if (!SKU_RE.test(body.sku)) {
    return (
      "sku must be uppercase alphanumeric with hyphens (e.g. 'APP-NIKE-JERSEY-M'). " +
      'Must start with a letter or digit. Length 3–50 characters.'
    )
  }

  // name
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return 'name is required and must be a non-empty string.'
  }

  // description — optional, but must be a string when provided
  if (body.description !== undefined && typeof body.description !== 'string') {
    return 'description must be a string when provided.'
  }

  if (body.school !== undefined) {
    if (typeof body.school !== 'string' || body.school.trim().length === 0) {
      return 'school must be a non-empty string when provided.'
    }
  }

  // license_body
  if (!body.license_body || !VALID_LICENSE_BODIES.has(body.license_body)) {
    return "license_body must be one of: 'CLC', 'ARMY', 'NONE'."
  }

  // royalty_rate
  if (body.royalty_rate !== undefined) {
    if (body.license_body === 'NONE') {
      return (
        "royalty_rate must not be provided when license_body is 'NONE'. " +
        'Unlicensed products carry no royalty obligation.'
      )
    }
    if (typeof body.royalty_rate !== 'number' || !isFinite(body.royalty_rate)) {
      return 'royalty_rate must be a finite number.'
    }
    if (body.royalty_rate <= 0 || body.royalty_rate > 1) {
      return 'royalty_rate must be greater than 0 and at most 1 (e.g. 0.145 for 14.5%).'
    }
  }

  // cost_cents
  if (body.cost_cents === undefined || body.cost_cents === null) {
    return 'cost_cents is required.'
  }
  if (!Number.isInteger(body.cost_cents) || body.cost_cents <= 0) {
    return 'cost_cents must be a positive integer (cents). Use a nominal value for comp/sample items.'
  }

  // retail_price_cents
  if (body.retail_price_cents === undefined || body.retail_price_cents === null) {
    return 'retail_price_cents is required.'
  }
  if (!Number.isInteger(body.retail_price_cents) || body.retail_price_cents <= 0) {
    return 'retail_price_cents must be a positive integer (cents).'
  }
  if (body.retail_price_cents < body.cost_cents) {
    return (
      `retail_price_cents (${body.retail_price_cents}) must be >= cost_cents (${body.cost_cents}). ` +
      'A product cannot be sold below cost.'
    )
  }

  return null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('create-product', req)
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

    const validationError = validate(body)
    if (validationError !== null) {
      return jsonError(req, validationError, 400)
    }

    // ── Step 6: Insert product ──────────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Creating product', {
      sku:          body.sku,
      license_body: body.license_body,
      cost_cents:   body.cost_cents,
      retail_price_cents: body.retail_price_cents,
    })

    const { data: product, error: insertError } = await admin
      .from('products')
      .insert({
        sku:                body.sku,
        name:               body.name.trim(),
        description:        body.description?.trim() ?? null,
        school:             body.school?.trim() ?? null,
        license_body:       body.license_body,
        royalty_rate:       body.royalty_rate ?? null,
        cost_cents:         body.cost_cents,
        retail_price_cents: body.retail_price_cents,
        created_by:         authorized.id,
      })
      .select()
      .single()

    if (insertError !== null) {
      // SKU conflict — surface as 409 with a clear message
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        authedLog.warn('SKU conflict', { sku: body.sku })
        return jsonError(
          req,
          `A product with SKU '${body.sku}' already exists. ` +
          'SKUs are globally unique and may not be reused, even for inactive products.',
          409,
        )
      }
      // Extract GTG-prefixed DB error (e.g. from SKU immutability trigger on edge cases)
      const gtgMatch = insertError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('Product insert failed', { error: insertError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    authedLog.info('Product created', {
      product_id:   product.id,
      sku:          product.sku,
      license_body: product.license_body,
    })

    return jsonResponse(req, product as Product, 201)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
