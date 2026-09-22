/**
 * GTG Edge Function — edit-product
 *
 * Admin product catalog management (4A-2).
 * Partial update (PATCH semantics) — only fields present in the request body
 * are written. At least one editable field must be provided.
 *
 * ─── Immutability ─────────────────────────────────────────────────────────────
 *
 * SKU is permanently immutable. The DB trigger prevent_sku_update() enforces
 * this at the database level; this function also rejects any request that
 * includes a 'sku' field with a 400 to make the constraint visible at the API
 * boundary before a round-trip.
 *
 * ─── Editable fields ──────────────────────────────────────────────────────────
 *
 *   name               string (non-empty)
 *   description        string | null (null clears the description)
 *   school             string | null (null clears the school)
 *   license_body       'CLC' | 'ARMY' | 'NONE'
 *   royalty_rate       number | null (null removes the per-product override;
 *                      units created after this change will inherit the
 *                      license_holder default rate)
 *   cost_cents         positive integer
 *   retail_price_cents positive integer, must be >= cost_cents (resolved)
 *   is_active          boolean
 *
 * ─── license_body / royalty_rate interaction ──────────────────────────────────
 *
 * These two fields interact. Validation resolves the effective state
 * (incoming value if provided, existing value otherwise) before checking:
 *
 *   - Effective license_body = 'NONE' + royalty_rate being set to a number → 400
 *     Unlicensed products carry no royalty obligation.
 *
 *   - license_body changed to 'NONE' + royalty_rate not in body:
 *     royalty_rate is automatically cleared (set to null) in the update.
 *     The product's previous rate override is irrelevant once it's unlicensed.
 *
 * ─── retail_price_cents / cost_cents interaction ──────────────────────────────
 *
 * Both values are resolved against the existing record when only one is
 * provided. A partial update that would produce retail_price < cost is rejected.
 *
 * ─── Pre-flight read ──────────────────────────────────────────────────────────
 *
 * The function fetches the current product before writing. This provides:
 *   - A 404 when the product does not exist.
 *   - The existing values needed for cross-field validation.
 *   - The current is_active state (inactive products may still be edited —
 *     admins must be able to correct and reactivate them).
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/edit-product
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "product_id":         "<uuid>",
 *     "name":               "Nike Jersey — Large",          // optional
 *     "description":        "Updated fit description.",     // optional; null to clear
 *     "school":             "University of Florida",        // optional; null to clear
 *     "license_body":       "CLC",                          // optional
 *     "royalty_rate":       0.15,                           // optional; null to clear
 *     "cost_cents":         2599,                           // optional
 *     "retail_price_cents": 5499,                           // optional
 *     "is_active":          true                            // optional
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "id":                 "<uuid>",
 *       "sku":                "APP-NIKE-JERSEY-M",
 *       "name":               "Nike Jersey — Large",
 *       "description":        "Updated fit description.",
 *       "school":             "University of Florida",
 *       "license_body":       "CLC",
 *       "royalty_rate":       0.15,
 *       "cost_cents":         2599,
 *       "retail_price_cents": 5499,
 *       "is_active":          true,
 *       "created_at":         "2026-03-06T...",
 *       "updated_at":         "2026-03-06T...",
 *       "created_by":         "<uuid>"
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message) or SKU field present in body
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
import { validateClcSchool } from '../_shared/licensed-schools.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE           = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_LICENSE_BODIES = new Set(['CLC', 'ARMY', 'NONE'])
const VALID_PRODUCT_CATEGORIES = new Set(['COLLECTIBLE', 'APPAREL'])
const VALID_LIFECYCLE_STATUSES = new Set(['DRAFT', 'READY_FOR_REVIEW', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED'])

// PostgreSQL unique_violation error code
const PG_UNIQUE_VIOLATION = '23505'

// ─── Types ────────────────────────────────────────────────────────────────────

// All editable fields are optional — only those present are updated.
// `description` and `royalty_rate` accept null to explicitly clear the value.
interface RequestBody {
  product_id:          string
  name?:               string
  description?:        string | null
  school?:             string | null
  license_body?:       string
  category?:           string
  color?:              string | null
  lifecycle_status?:   string
  royalty_rate?:       number | null
  cost_cents?:         number
  retail_price_cents?: number
  is_active?:          boolean
}

interface ExistingProduct {
  id:                 string
  sku:                string
  school:             string | null
  license_body:       string
  category:           string
  size:               string | null
  style_key:          string | null
  royalty_rate:       number | null
  cost_cents:         number
  retail_price_cents: number
  is_active:          boolean
}

interface Product {
  id:                 string
  sku:                string
  name:               string
  description:        string | null
  school:             string | null
  license_body:       string
  category:           string
  lifecycle_status:   string
  size:               string | null
  color:              string | null
  style_key:          string | null
  royalty_rate:       number | null
  cost_cents:         number
  retail_price_cents: number
  is_active:          boolean
  created_at:         string
  updated_at:         string
  created_by:         string
}

// ─── Editable field keys (used to detect at least one editable field) ─────────

const EDITABLE_FIELDS = new Set([
  'name', 'description', 'school', 'license_body', 'category', 'color',
  'lifecycle_status', 'royalty_rate', 'cost_cents', 'retail_price_cents',
  'is_active',
])

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('edit-product', req)
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

    // product_id
    if (!body.product_id || !UUID_RE.test(body.product_id)) {
      return jsonError(req, 'product_id must be a valid UUID.', 400)
    }

    // SKU is immutable — reject at the API boundary before any DB round-trip
    if ('sku' in body) {
      return jsonError(
        req,
        'sku is immutable and cannot be changed after creation. ' +
        'SKU is the stable key denormalized across units, ledger entries, ' +
        'commission records, and order lines.',
        400,
      )
    }

    // style_key is immutable (ADR-0001) — same treatment as sku. size is tied
    // to the physical units already received against this row and is not
    // editable either; a size correction means creating a new product.
    if ('style_key' in body) {
      return jsonError(
        req,
        'style_key is immutable and cannot be changed after creation. ' +
        'See docs/adr/0001-style-key-immutability.md.',
        400,
      )
    }
    if ('size' in body) {
      return jsonError(
        req,
        'size cannot be changed after creation. Create a new product for a ' +
        'different size.',
        400,
      )
    }

    // At least one editable field must be present
    const hasEditableField = Object.keys(body).some((k) => EDITABLE_FIELDS.has(k))
    if (!hasEditableField) {
      return jsonError(
        req,
        'At least one editable field must be provided: ' +
        'name, description, school, license_body, category, color, lifecycle_status, ' +
        'royalty_rate, cost_cents, retail_price_cents, is_active.',
        400,
      )
    }

    // ── Step 6: Pre-flight — fetch existing product ─────────────────────────────

    const admin = createAdminClient()

    const { data: existing, error: fetchError } = await admin
      .from('products')
      .select('id, sku, school, license_body, category, size, style_key, royalty_rate, cost_cents, retail_price_cents, is_active')
      .eq('id', body.product_id)
      .single()

    if (fetchError !== null || existing === null) {
      authedLog.warn('Product not found', { product_id: body.product_id })
      return jsonError(req, `Product '${body.product_id}' not found.`, 404)
    }

    const current = existing as ExistingProduct

    // ── Step 7: Cross-field validation ──────────────────────────────────────────

    // Resolve effective values (incoming if provided, existing otherwise)
    const effectiveLicenseBody = body.license_body ?? current.license_body
    const effectiveCostCents   = body.cost_cents   ?? current.cost_cents

    // style_key encodes school + garment type at creation time (ADR-0001) and
    // is itself immutable (rejected above). Changing `school` out from under
    // an existing style_key — or flipping `category` in or out of APPAREL
    // after the fact — would silently desync the two without ever touching
    // the immutable field itself, so both are rejected explicitly here.
    if (current.style_key !== null) {
      if (
        body.school !== undefined &&
        body.school !== null &&
        body.school.trim() !== current.school
      ) {
        return jsonError(
          req,
          `school cannot be changed for an apparel product once its style_key ` +
          `('${current.style_key}') has been generated. style_key is derived from ` +
          'school + garment type and is permanent — see docs/adr/0001-style-key-immutability.md. ' +
          'Create a new product for the new school instead.',
          400,
        )
      }
      if (body.category !== undefined && body.category !== current.category) {
        return jsonError(
          req,
          `category cannot be changed once a style_key ('${current.style_key}') has been ` +
          'generated — apparel identity is permanent. See docs/adr/0001-style-key-immutability.md.',
          400,
        )
      }
    } else if (body.category === 'APPAREL' && current.category !== 'APPAREL') {
      return jsonError(
        req,
        'category cannot be changed to APPAREL after creation — style_key can only be ' +
        'generated at creation time from school + garment type. Create a new apparel ' +
        'product instead. See docs/adr/0001-style-key-immutability.md.',
        400,
      )
    }

    // name
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return jsonError(req, 'name must be a non-empty string.', 400)
      }
    }

    // description
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') {
        return jsonError(req, 'description must be a string or null.', 400)
      }
    }

    if (body.school !== undefined && body.school !== null) {
      if (typeof body.school !== 'string' || body.school.trim().length === 0) {
        return jsonError(req, 'school must be a non-empty string or null.', 400)
      }
    }

    // Checking only the incoming `body.school` (when present) missed two
    // bypasses: switching license_body to 'CLC' without touching school, and
    // school already being null/unlicensed before this edit. Resolve the
    // effective post-update school and run it through the same shared
    // validator create-product and assign-product-license use.
    const effectiveSchool = body.school !== undefined ? body.school : current.school
    const clcSchoolError = validateClcSchool(effectiveLicenseBody, effectiveSchool)
    if (clcSchoolError !== null) {
      return jsonError(req, clcSchoolError, 400)
    }

    // license_body
    if (body.license_body !== undefined) {
      if (!VALID_LICENSE_BODIES.has(body.license_body)) {
        return jsonError(req, "license_body must be one of: 'CLC', 'ARMY', 'NONE'.", 400)
      }
    }

    // royalty_rate
    if (body.royalty_rate !== undefined && body.royalty_rate !== null) {
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
      // Setting a rate on an unlicensed product (resolved license_body = 'NONE')
      if (effectiveLicenseBody === 'NONE') {
        return jsonError(
          req,
          "royalty_rate must not be set when license_body is 'NONE'. " +
          'Unlicensed products carry no royalty obligation.',
          400,
        )
      }
    }

    // cost_cents
    if (body.cost_cents !== undefined) {
      if (!Number.isInteger(body.cost_cents) || body.cost_cents <= 0) {
        return jsonError(
          req,
          'cost_cents must be a positive integer (cents).',
          400,
        )
      }
    }

    // retail_price_cents — validate against resolved cost
    if (body.retail_price_cents !== undefined) {
      if (!Number.isInteger(body.retail_price_cents) || body.retail_price_cents <= 0) {
        return jsonError(req, 'retail_price_cents must be a positive integer (cents).', 400)
      }
      if (body.retail_price_cents < effectiveCostCents) {
        return jsonError(
          req,
          `retail_price_cents (${body.retail_price_cents}) must be >= cost_cents ` +
          `(${effectiveCostCents}). A product cannot be sold below cost.`,
          400,
        )
      }
    }

    // is_active
    if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
      return jsonError(req, 'is_active must be a boolean.', 400)
    }

    // category
    if (body.category !== undefined && !VALID_PRODUCT_CATEGORIES.has(body.category)) {
      return jsonError(req, `category must be one of: ${[...VALID_PRODUCT_CATEGORIES].join(', ')}.`, 400)
    }

    // color
    if (body.color !== undefined && body.color !== null) {
      if (typeof body.color !== 'string' || body.color.trim().length === 0) {
        return jsonError(req, 'color must be a non-empty string or null.', 400)
      }
    }

    // lifecycle_status
    if (body.lifecycle_status !== undefined && !VALID_LIFECYCLE_STATUSES.has(body.lifecycle_status)) {
      return jsonError(
        req,
        `lifecycle_status must be one of: ${[...VALID_LIFECYCLE_STATUSES].join(', ')}.`,
        400,
      )
    }

    // lifecycle_status is the descriptive form of the operative is_active
    // flag. Accept either field on its own by deriving its counterpart, but
    // reject contradictory pairs rather than allowing impossible states such
    // as ARCHIVED + is_active=true. The database enforces the same invariant.
    if (
      body.lifecycle_status !== undefined &&
      body.is_active !== undefined &&
      (body.lifecycle_status === 'ACTIVE') !== body.is_active
    ) {
      return jsonError(
        req,
        "lifecycle_status and is_active disagree: ACTIVE requires is_active=true; all other lifecycle states require is_active=false.",
        400,
      )
    }

    // ── Step 8: Build update payload ────────────────────────────────────────────

    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = {}

    if (body.name        !== undefined) patch.name        = body.name.trim()
    if (body.description !== undefined) patch.description = body.description?.trim() ?? null
    if (body.school      !== undefined) patch.school      = body.school?.trim() ?? null
    if (body.license_body !== undefined) patch.license_body = body.license_body
    if (body.category    !== undefined) patch.category    = body.category
    if (body.color       !== undefined) patch.color       = body.color?.trim() ?? null
    if (body.lifecycle_status !== undefined) {
      patch.lifecycle_status = body.lifecycle_status
      patch.is_active = body.lifecycle_status === 'ACTIVE'
    }
    if (body.cost_cents  !== undefined) patch.cost_cents  = body.cost_cents
    if (body.retail_price_cents !== undefined) patch.retail_price_cents = body.retail_price_cents
    if (body.is_active !== undefined) {
      patch.is_active = body.is_active
      if (body.lifecycle_status === undefined) {
        patch.lifecycle_status = body.is_active ? 'ACTIVE' : 'DISCONTINUED'
      }
    }

    // royalty_rate requires special handling:
    //   a) Explicitly provided (number or null) → use directly
    //   b) Not in body but switching to 'NONE' → auto-clear
    if (body.royalty_rate !== undefined) {
      patch.royalty_rate = body.royalty_rate ?? null
    } else if (body.license_body === 'NONE' && current.license_body !== 'NONE') {
      // Switching from a licensed body to NONE — clear the override rate automatically
      patch.royalty_rate = null
    }

    authedLog.info('Updating product', {
      product_id: body.product_id,
      fields:     Object.keys(patch),
    })

    // ── Step 9: Execute update ──────────────────────────────────────────────────

    const { data: updated, error: updateError } = await admin
      .from('products')
      .update(patch)
      .eq('id', body.product_id)
      .select()
      .single()

    if (updateError !== null) {
      // color is the only apparel field this endpoint can still change once a
      // style_key exists — editing it into a value another sibling (same
      // style_key + size) already has hits the same unique constraint
      // create-product's insert enforces. Give the same clear 409 here too,
      // rather than falling through to a generic 500.
      if (
        updateError.code === PG_UNIQUE_VIOLATION &&
        updateError.message.includes('products_apparel_variant_unique')
      ) {
        authedLog.warn('Duplicate apparel variant', {
          style_key: current.style_key,
          size:      current.size,
          color:     patch.color ?? null,
        })
        return jsonError(
          req,
          `A product already exists for this exact size/color combination ` +
          `(style_key '${current.style_key}', size '${current.size}'` +
          `${patch.color ? `, color '${patch.color}'` : ''}). ` +
          'Each size/color combination may only be represented by one product.',
          409,
        )
      }

      const gtgMatch = updateError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('Product update failed', { error: updateError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    authedLog.info('Product updated', {
      product_id:   updated.id,
      sku:          updated.sku,
      fields:       Object.keys(patch),
    })

    return jsonResponse(req, updated as Product)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
