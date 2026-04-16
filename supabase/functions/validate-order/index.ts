/**
 * GTG Edge Function — validate-order
 *
 * Pre-payment integrity check for an order. Called by the storefront and
 * consultant app before submitting to the payment gateway.
 *
 * Validations performed (all must pass for `valid: true`):
 *   1. Order exists in the database.
 *   2. Order status allows submission (draft or pending_payment).
 *   3. Caller is authorized to validate this order (ownership check).
 *   4. At least one non-cancelled order line is present.
 *   5. Total ≥ 1 cent (payment gateway rejects $0 charges).
 *   6. Financial arithmetic: total = subtotal - discount + shipping + tax.
 *   7. Subtotal matches the sum of non-cancelled line retail prices.
 *   8. All units on non-cancelled lines are available or reserved to this order.
 *   9. Consultant attribution: consultant_id required when channel is
 *      'consultant_assisted'.
 *  10. Shipping address: all required fields are non-empty strings.
 *
 * Authorization: ALL_ROLES — any authenticated user may call this function.
 * Ownership: customers may validate only their own orders; consultants may
 * validate only orders attributed to them; admins may validate any order.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/validate-order
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *   { "order_id": "uuid" }
 *
 * ─── Success response (valid) ─────────────────────────────────────────────────
 *
 *   200  { "data": { "valid": true, "order_id": "...", "order_number": "..." } }
 *
 * ─── Success response (invalid) ───────────────────────────────────────────────
 *
 *   200  {
 *     "data": {
 *       "valid": false,
 *       "order_id": "...",
 *       "order_number": "...",
 *       "errors": [
 *         { "code": "FINANCIAL_MISMATCH", "message": "..." },
 *         ...
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing / malformed order_id)
 *   401  Unauthenticated
 *   403  Forbidden (ownership check failed)
 *   404  Order not found
 *   422  Order is in a non-validatable status
 *   500  Internal server error
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve validate-order --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/validate-order' \
 *     --header 'Authorization: Bearer <jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{"order_id": "<uuid>"}'
 */

import { ALL_ROLES, ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  order_id: string
}

/** A single validation failure. */
interface ValidationError {
  /** Machine-readable code for client-side handling. */
  code: ValidationErrorCode
  /** Human-readable explanation (internal; not shown to end customers). */
  message: string
}

type ValidationErrorCode =
  | 'INVALID_STATUS'      // Order status does not allow payment submission
  | 'NO_ACTIVE_LINES'     // No non-cancelled lines exist on the order
  | 'ZERO_TOTAL'          // Total is zero or negative
  | 'FINANCIAL_MISMATCH'  // total ≠ subtotal - discount + shipping + tax
  | 'SUBTOTAL_MISMATCH'   // subtotal ≠ sum of line retail prices
  | 'UNIT_NOT_AVAILABLE'  // A unit is not available or is reserved to a different order
  | 'MISSING_CONSULTANT'  // Channel is consultant_assisted but consultant_id is null
  | 'INCOMPLETE_ADDRESS'  // A required shipping address field is missing

/** Statuses from which an order may proceed to payment. */
const SUBMITTABLE_STATUSES = new Set(['draft', 'pending_payment'])

/** Required non-empty string fields on the shipping address JSONB. */
const REQUIRED_ADDRESS_FIELDS = [
  'recipientName',
  'line1',
  'city',
  'state',
  'postalCode',
  'country',
] as const

interface ResponsePayload {
  valid: boolean
  order_id: string
  order_number: string
  errors?: ValidationError[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return a ValidationError object (named helper for consistent shape). */
function validationError(
  code: ValidationErrorCode,
  message: string,
): ValidationError {
  return { code, message }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('validate-order', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ──────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ─────────────────────────────────────────────────────
    // Any authenticated role may validate an order. Ownership is checked below
    // after the order is fetched — non-owners receive a 403, not a 404, so that
    // the error message is accurate and the order_id is not silently swallowed.

    const { authorized, denied } = verifyRole(user, ALL_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ───────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.order_id || typeof body.order_id !== 'string') {
      return jsonError(req, 'Missing required field: order_id', 400)
    }

    // Basic UUID v4 shape check — the DB will reject invalid UUIDs anyway, but
    // catching it here avoids a cryptic Postgres error in the logs.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidPattern.test(body.order_id)) {
      return jsonError(req, 'order_id must be a valid UUID v4', 400)
    }

    // ── Step 6: Fetch order and lines ─────────────────────────────────────────
    // Use the admin client so that RLS policies on orders do not interfere with
    // the server-side ownership check we perform explicitly below. This is safe
    // because verifyRole() has already confirmed the caller is authenticated.

    const admin = createAdminClient()

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        channel,
        customer_id,
        consultant_id,
        subtotal_cents,
        discount_cents,
        shipping_cents,
        tax_cents,
        total_cents,
        shipping_address
      `)
      .eq('id', body.order_id)
      .single()

    if (orderError !== null) {
      if (orderError.code === 'PGRST116') {
        // PostgREST "no rows" code — order does not exist
        authedLog.warn('Order not found', { order_id: body.order_id })
        return jsonError(req, `Order not found: ${body.order_id}`, 404)
      }
      authedLog.error('DB error fetching order', {
        order_id: body.order_id,
        code: orderError.code,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Ownership check ───────────────────────────────────────────────────────
    // Admins may validate any order. Non-admins may only validate orders that
    // belong to them (customer_id or consultant_id matches their user id).

    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(authorized.role)
    if (!isAdmin) {
      const ownsOrder =
        order.customer_id === authorized.id ||
        order.consultant_id === authorized.id

      if (!ownsOrder) {
        authedLog.warn('Ownership check failed', {
          order_id: order.id,
          role: authorized.role,
        })
        return jsonError(req, 'You are not authorized to validate this order', 403)
      }
    }

    // ── Status gate ───────────────────────────────────────────────────────────
    // Reject immediately for orders that are already past the point of no return.
    // This is a hard 422 (not a validation error list) because the caller has
    // sent the wrong order, not a corrupt draft.

    if (!SUBMITTABLE_STATUSES.has(order.status)) {
      authedLog.warn('Order not in submittable status', {
        order_id: order.id,
        status: order.status,
      })
      return jsonError(
        req,
        `Order ${order.order_number} has status '${order.status}' and cannot be submitted for payment. ` +
        `Only orders with status 'draft' or 'pending_payment' may be validated.`,
        422,
      )
    }

    // ── Fetch non-cancelled lines with unit status ────────────────────────────

    const { data: lines, error: linesError } = await admin
      .from('order_lines')
      .select(`
        id,
        unit_id,
        serial_number,
        retail_price_cents,
        serialized_units ( status, order_id )
      `)
      .eq('order_id', order.id)
      .neq('status', 'cancelled')

    if (linesError !== null) {
      authedLog.error('DB error fetching order lines', {
        order_id: order.id,
        code: linesError.code,
      })
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('Order fetched', {
      order_id: order.id,
      status: order.status,
      line_count: lines.length,
    })

    // ── Step 7: Run validations ───────────────────────────────────────────────

    const errors: ValidationError[] = []

    // ── Check 1: At least one active line ─────────────────────────────────────
    if (lines.length === 0) {
      errors.push(validationError(
        'NO_ACTIVE_LINES',
        'Order has no active (non-cancelled) lines. At least one line is required.',
      ))
    }

    // ── Check 2: Total > 0 ────────────────────────────────────────────────────
    if (order.total_cents <= 0) {
      errors.push(validationError(
        'ZERO_TOTAL',
        `Order total is ${order.total_cents} cents. Total must be at least 1 cent.`,
      ))
    }

    // ── Check 3: Financial arithmetic ─────────────────────────────────────────
    // total = subtotal - discount + shipping + tax
    const expectedTotal =
      order.subtotal_cents -
      order.discount_cents +
      order.shipping_cents +
      order.tax_cents

    if (expectedTotal !== order.total_cents) {
      errors.push(validationError(
        'FINANCIAL_MISMATCH',
        `Order total does not match components. ` +
        `subtotal(${order.subtotal_cents}) - discount(${order.discount_cents}) ` +
        `+ shipping(${order.shipping_cents}) + tax(${order.tax_cents}) ` +
        `= ${expectedTotal}, but total_cents = ${order.total_cents}.`,
      ))
    }

    // ── Check 4: Subtotal matches sum of line prices ───────────────────────────
    if (lines.length > 0) {
      const lineSum = lines.reduce(
        (acc, line) => acc + (line.retail_price_cents ?? 0),
        0,
      )
      if (lineSum !== order.subtotal_cents) {
        errors.push(validationError(
          'SUBTOTAL_MISMATCH',
          `Order subtotal_cents (${order.subtotal_cents}) does not match the sum ` +
          `of non-cancelled line retail prices (${lineSum}).`,
        ))
      }
    }

    // ── Check 5: Unit availability ────────────────────────────────────────────
    // Each unit must be either:
    //   - 'available' (not yet reserved — valid for a draft order being submitted)
    //   - 'reserved'  (already reserved to this specific order — valid for retry)
    // Any other status (sold, fraud_locked, voided, returned) or a reservation
    // to a *different* order means the unit cannot be sold in this transaction.
    for (const line of lines) {
      // Supabase returns the joined row under the table name key
      const unit = Array.isArray(line.serialized_units)
        ? line.serialized_units[0]
        : line.serialized_units

      if (unit === null || unit === undefined) {
        errors.push(validationError(
          'UNIT_NOT_AVAILABLE',
          `Unit for line (unit_id=${line.unit_id}, serial=${line.serial_number}) ` +
          `could not be found. The unit may have been deleted.`,
        ))
        continue
      }

      const unitStatus = unit.status as string
      const unitOrderId = unit.order_id as string | null

      if (unitStatus === 'available') {
        // Fine — unit is free to be reserved.
        continue
      }

      if (unitStatus === 'reserved') {
        if (unitOrderId === order.id) {
          // Fine — already reserved to this order (pending_payment retry).
          continue
        }
        errors.push(validationError(
          'UNIT_NOT_AVAILABLE',
          `Unit ${line.serial_number} (unit_id=${line.unit_id}) is reserved to a ` +
          `different order (order_id=${unitOrderId}). It cannot be included in this order.`,
        ))
        continue
      }

      // Status is sold, fraud_locked, voided, or returned.
      errors.push(validationError(
        'UNIT_NOT_AVAILABLE',
        `Unit ${line.serial_number} (unit_id=${line.unit_id}) has status '${unitStatus}' ` +
        `and is not available for sale.`,
      ))
    }

    // ── Check 6: Consultant attribution ───────────────────────────────────────
    if (order.channel === 'consultant_assisted' && order.consultant_id === null) {
      errors.push(validationError(
        'MISSING_CONSULTANT',
        `Order channel is 'consultant_assisted' but consultant_id is null. ` +
        `A consultant must be attributed before this order can be submitted.`,
      ))
    }

    // ── Check 7: Shipping address completeness ────────────────────────────────
    const address = order.shipping_address as Record<string, unknown> | null

    if (address === null || typeof address !== 'object') {
      errors.push(validationError(
        'INCOMPLETE_ADDRESS',
        'shipping_address is missing or not a valid object.',
      ))
    } else {
      for (const field of REQUIRED_ADDRESS_FIELDS) {
        const value = address[field]
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(validationError(
            'INCOMPLETE_ADDRESS',
            `shipping_address.${field} is required and must be a non-empty string.`,
          ))
        }
      }
    }

    // ── Step 8: Build response ────────────────────────────────────────────────

    const valid = errors.length === 0

    authedLog.info('Validation complete', {
      order_id: order.id,
      order_number: order.order_number,
      valid,
      error_count: errors.length,
    })

    const payload: ResponsePayload = valid
      ? { valid: true, order_id: order.id, order_number: order.order_number }
      : { valid: false, order_id: order.id, order_number: order.order_number, errors }

    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
