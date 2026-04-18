/**
 * GTG Edge Function — list-products
 *
 * Storefront product catalog with license-based filtering (5A-1).
 * Returns active products visible to the caller, annotated with real-time
 * available unit counts. The primary discovery surface for the storefront.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * Any authenticated user (consultant, admin). Active products are filtered
 * via explicit .eq('active', true) — the products table uses the `active`
 * column. The storefront never surfaces inactive products.
 *
 * ─── License-based filtering ──────────────────────────────────────────────────
 *
 * license_body filters the catalog by licensing authority. Consultants
 * authorized to sell CLC merchandise pass license_body = "CLC" to see only
 * CLC-licensed products. Omitting license_body returns the full active catalog.
 *
 * Valid values: "CLC", "ARMY", "NONE". Accepts a single string or an array.
 *
 * ─── Stock annotation ─────────────────────────────────────────────────────────
 *
 * Each product in the response includes:
 *   available_count  integer   Units currently in 'available' status.
 *   in_stock         boolean   true when available_count > 0.
 *
 * Stock counts are computed in a single aggregation query (one DB round-trip
 * regardless of page size) via get_available_unit_counts.
 *
 * ─── Search ───────────────────────────────────────────────────────────────────
 *
 * search performs a case-insensitive substring match against product name.
 * Combine with license_body for scoped catalog search.
 *
 * ─── Sensitive fields excluded ────────────────────────────────────────────────
 *
 * cost_cents and created_by are internal fields and are excluded from the
 * storefront response. Retail price is included — it is the displayed price.
 *
 * ─── Pagination ───────────────────────────────────────────────────────────────
 *
 * limit   Default 50, max 200.
 * offset  Default 0.
 * total   Exact row count returned alongside each page.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/list-products
 *   Authorization: Bearer <user-jwt>
 *   Content-Type: application/json
 *
 *   All filters optional:
 *   {
 *     "license_body": "CLC",          // or ["CLC", "ARMY"], or omit for all
 *     "search":       "jersey",        // optional name search
 *     "limit":        50,
 *     "offset":       0
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "products": [
 *         {
 *           "id":                 "<uuid>",
 *           "sku":                "APP-NIKE-JERSEY-M",
 *           "name":               "Nike Jersey — Medium",
 *           "description":        "Official CLC-licensed jersey...",
 *           "license_body":       "CLC",
 *           "retail_price_cents": 4999,
 *           "available_count":    23,
 *           "in_stock":           true,
 *           "created_at":         "2026-03-01T...",
 *           "updated_at":         "2026-03-04T..."
 *         }
 *       ],
 *       "total":  47,
 *       "limit":  50,
 *       "offset": 0
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   500  Internal server error
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, getUserFromRequest } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_LICENSE_BODIES = new Set(['CLC', 'ARMY', 'NONE'])
const DEFAULT_LIMIT        = 50
const MAX_LIMIT            = 200

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  license_body?: string | string[]
  search?:       string
  school?:       string
  limit?:        number
  offset?:       number
}

interface ProductRow {
  id:                 string
  sku:                string
  name:               string
  school:             string | null
  license_body:       string
  retail_price_cents: number
  created_at:         string
}

interface CountRow {
  product_id:      string
  available_count: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('list-products', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────────
    //
    // Any authenticated user may browse the catalog.
    // RLS on products limits non-admin callers to is_active = true rows.

    const { data: { user }, error: authError } = await getUserFromRequest(req)

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    const authedLog = log.withUser(user.id)

    authedLog.info('Authenticated')

    // ── Step 4: Parse and validate request body ─────────────────────────────────

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      // Empty or missing body — treat as no filters
    }

    // ── Validate license_body filter ──

    if (body.license_body !== undefined) {
      const bodies = toArray(body.license_body as string | string[])
      if (bodies.length === 0) {
        return jsonError(req, 'license_body must be a non-empty string or array.', 400)
      }
      const invalid = bodies.filter((b) => !VALID_LICENSE_BODIES.has(b))
      if (invalid.length > 0) {
        return jsonError(
          req,
          `Invalid license_body value(s): ${invalid.join(', ')}. ` +
          `Valid values: ${[...VALID_LICENSE_BODIES].join(', ')}.`,
          400,
        )
      }
    }

    // ── Validate search ──

    if (body.search !== undefined &&
        (typeof body.search !== 'string' || body.search.trim().length === 0)) {
      return jsonError(req, 'search must be a non-empty string when provided.', 400)
    }

    if (body.school !== undefined &&
        (typeof body.school !== 'string' || body.school.trim().length === 0)) {
      return jsonError(req, 'school must be a non-empty string when provided.', 400)
    }

    // ── Validate pagination ──

    const limit  = body.limit  ?? DEFAULT_LIMIT
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

    // ── Step 5: Build and execute product query ─────────────────────────────────
    //
    // Explicit .eq('active', true) filter — the products table uses `active`
    // (not `is_active`). RLS policies referencing is_active are broken against
    // this schema; the explicit filter is the authoritative guard here.
    // cost_cents and created_by are excluded — internal fields not for storefront.

    authedLog.info('Querying products', {
      license_body: body.license_body,
      search:       body.search,
      school:       body.school,
      limit,
      offset,
    })

    let productQuery = createAdminClient()
      .from('products')
      .select(
        'id, sku, name, school, license_body:license_type, retail_price_cents:price, created_at',
        { count: 'exact' },
      )
      .eq('active', true)
      .order('name', { ascending: true })
      .range(offset, offset + limit - 1)

    if (body.license_body !== undefined) {
      const bodies = toArray(body.license_body as string | string[])
      productQuery = bodies.length === 1
        ? productQuery.eq('license_type', bodies[0])
        : productQuery.in('license_type', bodies)
    }

    if (body.search !== undefined) {
      productQuery = productQuery.ilike('name', `%${body.search.trim()}%`)
    }

    if (body.school !== undefined) {
      productQuery = productQuery.eq('school', body.school.trim())
    }

    const { data: products, error: productError, count } = await productQuery

    if (productError !== null) {
      authedLog.error('Products query failed', { error: productError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const productRows = (products ?? []) as ProductRow[]
    const total       = count ?? 0

    // ── Step 6: Fetch available unit counts for this page ───────────────────────
    //
    // get_available_unit_counts aggregates in the DB — one query regardless of
    // page size. Products with zero available units are absent from the result;
    // the Map lookup defaults to 0.

    let countMap = new Map<string, number>()

    if (productRows.length > 0) {
      const productIds = productRows.map((p) => p.id)

      const { data: counts, error: countError } = await createAdminClient().rpc(
        'get_available_unit_counts',
        { p_product_ids: productIds },
      )

      if (countError !== null) {
        authedLog.error('Available unit count query failed', { error: countError.message })
        return jsonError(req, 'Internal server error', 500)
      }

      countMap = new Map(
        ((counts ?? []) as CountRow[]).map((row) => [row.product_id, row.available_count]),
      )
    }

    // ── Step 7: Merge stock counts and return ───────────────────────────────────

    const annotated = productRows.map((product) => {
      const availableCount = countMap.get(product.id) ?? 0
      return {
        id:                 product.id,
        sku:                product.sku,
        name:               product.name,
        description:        null,
        school:             product.school,
        license_body:       product.license_body,
        retail_price_cents: product.retail_price_cents,
        available_count:    availableCount,
        in_stock:           availableCount > 0,
        created_at:         product.created_at,
        updated_at:         product.created_at,
      }
    })

    authedLog.info('Products returned', {
      count:  annotated.length,
      total,
      in_stock_count: annotated.filter((p) => p.in_stock).length,
    })

    return jsonResponse(req, {
      products: annotated,
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
