/**
 * GTG Edge Function — check-availability
 *
 * Real-time stock availability check for one or more products (5A-2).
 * Lightweight companion to list-products (5A-1) — called when the storefront
 * needs a fresh stock count without re-fetching the full catalog page.
 *
 * ─── When to use this endpoint ────────────────────────────────────────────────
 *
 *   list-products (5A-1) annotates catalog pages with available_count.
 *   check-availability is for targeted refreshes:
 *     - Product detail page load (confirm current stock)
 *     - Pre-add-to-cart confirmation (stock may have changed since catalog load)
 *     - Cart review before checkout (confirm nothing sold out while browsing)
 *     - Polling for restocks on a specific product
 *
 * ─── Input ────────────────────────────────────────────────────────────────────
 *
 * product_ids   Array of 1–50 product UUIDs. All must be active products
 *               visible to the caller (inactive products are treated as not
 *               found). Duplicates are rejected.
 *
 * ─── Stock counts ─────────────────────────────────────────────────────────────
 *
 * available_count reflects units currently in 'available' status — not
 * reserved, sold, fraud_locked, returned, or voided. A unit moves out of
 * 'available' the moment it is reserved for an order. The count is
 * authoritative at the moment of the query but not a reservation guarantee.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * Any authenticated user (consultant, admin). RLS on products restricts
 * non-admin callers to active products only.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/check-availability
 *   Authorization: Bearer <user-jwt>
 *   Content-Type: application/json
 *   {
 *     "product_ids": ["<uuid>", "<uuid>"]
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "availability": [
 *         {
 *           "product_id":         "<uuid>",
 *           "sku":                "APP-NIKE-JERSEY-M",
 *           "name":               "Nike Jersey — Medium",
 *           "license_body":       "CLC",
 *           "retail_price_cents": 4999,
 *           "available_count":    23,
 *           "in_stock":           true
 *         },
 *         {
 *           "product_id":         "<uuid>",
 *           "sku":                "APP-ARMY-HOODIE-L",
 *           "name":               "Army Hoodie — Large",
 *           "license_body":       "ARMY",
 *           "retail_price_cents": 6499,
 *           "available_count":    0,
 *           "in_stock":           false
 *         }
 *       ]
 *     }
 *   }
 *
 *   Results are returned in the same order as the input product_ids.
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   404  One or more product_ids not found or not active
 *   500  Internal server error
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PRODUCTS = 50

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  product_ids?: unknown
}

interface ProductRow {
  id:                 string
  sku:                string
  name:               string
  license_body:       string
  retail_price_cents: number
}

interface CountRow {
  product_id:      string
  available_count: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('check-availability', req)
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

    const authedLog = log.withUser(user.id)
    authedLog.info('Authenticated')

    // ── Step 4: Parse and validate request body ─────────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!Array.isArray(body.product_ids)) {
      return jsonError(req, 'product_ids must be an array of product UUIDs.', 400)
    }

    const rawIds = body.product_ids as unknown[]

    if (rawIds.length === 0) {
      return jsonError(req, 'product_ids must not be empty.', 400)
    }

    if (rawIds.length > MAX_PRODUCTS) {
      return jsonError(
        req,
        `product_ids may contain at most ${MAX_PRODUCTS} entries per request.`,
        400,
      )
    }

    const invalidIds = rawIds.filter((id) => typeof id !== 'string' || !UUID_RE.test(id as string))
    if (invalidIds.length > 0) {
      return jsonError(
        req,
        `product_ids contains invalid values. All entries must be valid UUIDs. ` +
        `Invalid: ${invalidIds.slice(0, 5).join(', ')}${invalidIds.length > 5 ? ` (+${invalidIds.length - 5} more)` : ''}.`,
        400,
      )
    }

    const uniqueIds = [...new Set(rawIds as string[])]
    if (uniqueIds.length !== rawIds.length) {
      return jsonError(
        req,
        'product_ids contains duplicate entries. Each product ID must appear at most once.',
        400,
      )
    }

    // ── Step 5: Verify all products exist and are active ────────────────────────
    //
    // userClient applies RLS: non-admin callers see only is_active = true.
    // Any ID not returned was not found or is inactive — both are treated as 404.

    authedLog.info('Checking product availability', { product_count: uniqueIds.length })

    const { data: products, error: productError } = await createAdminClient()
      .from('products')
      .select('id, sku, name, license_body:license_type, retail_price_cents:price')
      .in('id', uniqueIds)
      .eq('active', true)

    if (productError !== null) {
      authedLog.error('Products query failed', { error: productError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const foundProducts = (products ?? []) as ProductRow[]

    if (foundProducts.length !== uniqueIds.length) {
      const foundIds = new Set(foundProducts.map((p) => p.id))
      const missing  = uniqueIds.filter((id) => !foundIds.has(id))
      authedLog.warn('Products not found or inactive', { missing })
      return jsonError(
        req,
        `The following product IDs were not found or are not active: ${missing.join(', ')}.`,
        404,
      )
    }

    // ── Step 6: Fetch available unit counts ─────────────────────────────────────
    //
    // SECURITY DEFINER function — runs as function owner, bypasses RLS.
    // Safe: returns only aggregate counts, no unit-level data.

    const { data: counts, error: countError } = await createAdminClient().rpc(
      'get_available_unit_counts',
      { p_product_ids: uniqueIds },
    )

    if (countError !== null) {
      authedLog.error('Unit count query failed', { error: countError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const countMap = new Map(
      ((counts ?? []) as CountRow[]).map((row) => [row.product_id, row.available_count]),
    )

    // ── Step 7: Assemble response in input order ─────────────────────────────────
    //
    // Build a lookup map from the DB result, then map over the original uniqueIds
    // array to preserve caller-supplied order. Clients rely on positional matching
    // when updating multiple product cards simultaneously.

    const productMap = new Map(foundProducts.map((p) => [p.id, p]))

    const availability = uniqueIds.map((id) => {
      const product        = productMap.get(id)!
      const availableCount = countMap.get(id) ?? 0
      return {
        product_id:         product.id,
        sku:                product.sku,
        name:               product.name,
        license_body:       product.license_body,
        retail_price_cents: product.retail_price_cents,
        available_count:    availableCount,
        in_stock:           availableCount > 0,
      }
    })

    authedLog.info('Availability check complete', {
      checked:       availability.length,
      in_stock:      availability.filter((a) => a.in_stock).length,
      out_of_stock:  availability.filter((a) => !a.in_stock).length,
    })

    return jsonResponse(req, { availability })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
