/**
 * GTG Edge Function — verify-serial
 *
 * Public hologram verification by serial number (5C-1).
 * Confirms a serialized unit is a genuine GTG-issued product and returns
 * safe public-facing details about the unit's authenticity and status.
 *
 * ─── Use case ─────────────────────────────────────────────────────────────────
 *
 * A customer receives a licensed product with a GTG hologram sticker or QR code.
 * They scan the code (or enter the serial number manually) to confirm the product
 * is authentic, licensed, and has not been counterfeited or double-sold.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * This endpoint requires NO authentication. It is fully public.
 * No user JWT is required or accepted.
 *
 * Security model: only safe public fields are returned. Internal data (cost_cents,
 * fraud_lock_reason, order_id, consultant_id, retail_price_cents) is never
 * exposed. The fraud_locked status is mapped to a neutral public label so as not
 * to reveal active investigations.
 *
 * ─── Input ────────────────────────────────────────────────────────────────────
 *
 * serial_number   The physical serial number from the hologram or QR code.
 *                 Case-insensitive. Whitespace is trimmed. Max 100 characters.
 *
 * ─── Verification status values ───────────────────────────────────────────────
 *
 *   in_circulation   Unit exists and has not yet been sold (available or reserved)
 *   sold             Unit was legitimately purchased
 *   returned         Unit was sold and subsequently returned
 *   under_review     Unit is undergoing an internal review (fraud_locked)
 *   decommissioned   Unit has been permanently removed from circulation (voided)
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/verify-serial
 *   Content-Type: application/json
 *   {
 *     "serial_number": "GTG-CLC-2026-0001"
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "verified":            true,
 *       "serial_number":       "GTG-CLC-2026-0001",
 *       "sku":                 "APP-NIKE-JERSEY-M",
 *       "product_name":        "Nike Jersey — Medium",
 *       "license_body":        "CLC",
 *       "hologram":            { ... },      // HologramRecord snapshot or null
 *       "verification_status": "sold",
 *       "received_at":         "2026-01-15T10:00:00Z",
 *       "sold_at":             "2026-03-05T14:22:11Z"  // null if not sold
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (missing or invalid serial_number)
 *   404  Serial number not found — not a genuine GTG unit
 *   500  Internal server error
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse } from '../_shared/response.ts'
import { createAdminClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SERIAL_LENGTH = 100

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  serial_number?: unknown
}

interface UnitRow {
  serial_number: string
  sku:           string
  product_name:  string
  license_body:  string
  status:        string
  hologram:      unknown
  received_at:   string
  sold_at:       string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Maps the internal unit_status to a public-safe verification_status label.
 * fraud_locked is deliberately exposed as 'under_review' — not 'fraud_locked' —
 * to avoid revealing active investigation status to adversarial actors.
 */
function toVerificationStatus(status: string): string {
  switch (status) {
    case 'available':
    case 'reserved':    return 'in_circulation'
    case 'sold':        return 'sold'
    case 'returned':    return 'returned'
    case 'fraud_locked': return 'under_review'
    case 'voided':      return 'decommissioned'
    default:            return 'unknown'
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('verify-serial', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Parse request body ───────────────────────────────────────────
    // No authentication — this endpoint is fully public.

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    // ── Step 4: Validate serial_number input ─────────────────────────────────

    if (body.serial_number === undefined || body.serial_number === null) {
      return jsonError(req, 'serial_number is required.', 400)
    }

    if (typeof body.serial_number !== 'string') {
      return jsonError(req, 'serial_number must be a string.', 400)
    }

    const serialNumber = body.serial_number.trim().toUpperCase()

    if (serialNumber.length === 0) {
      return jsonError(req, 'serial_number must not be empty.', 400)
    }

    if (serialNumber.length > MAX_SERIAL_LENGTH) {
      return jsonError(
        req,
        `serial_number must be at most ${MAX_SERIAL_LENGTH} characters.`,
        400,
      )
    }

    log.info('Verifying serial number', { serial_number: serialNumber })

    // ── Step 5: Look up the unit by serial number ────────────────────────────
    //
    // Admin client required — serialized_units RLS restricts non-admin callers
    // to available units only (status = 'available'). Public verification must
    // be able to confirm sold, returned, and other non-available units as genuine.
    //
    // Only the safe public fields are selected. cost_cents, retail_price_cents,
    // fraud_lock_reason, fraud_locked_by, order_id, consultant_id are never
    // included in this query to prevent accidental future exposure.

    const admin = createAdminClient()

    const { data, error } = await admin
      .from('serialized_units')
      .select('serial_number, sku, product_name, license_body, status, hologram, received_at, sold_at')
      .eq('serial_number', serialNumber)
      .maybeSingle()

    if (error !== null) {
      log.error('Unit lookup failed', { error: error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 6: Return 404 for unknown serial numbers ────────────────────────
    //
    // A serial number not in our database is not a genuine GTG unit.
    // The 404 message is intentionally generic — do not distinguish between
    // "never issued" and "voided" to avoid revealing inventory data.

    if (data === null) {
      log.info('Serial number not found', { serial_number: serialNumber })
      return jsonError(
        req,
        `Serial number '${serialNumber}' was not found. ` +
        'This may not be a genuine GTG-issued product. ' +
        'If you believe this is an error, contact support@gametimegift.com.',
        404,
      )
    }

    const unit = data as UnitRow

    // ── Step 7: Build public verification response ───────────────────────────

    const verificationStatus = toVerificationStatus(unit.status)

    log.info('Serial number verified', {
      serial_number:       unit.serial_number,
      verification_status: verificationStatus,
      license_body:        unit.license_body,
    })

    return jsonResponse(req, {
      verified:            true,
      serial_number:       unit.serial_number,
      sku:                 unit.sku,
      product_name:        unit.product_name,
      license_body:        unit.license_body,
      hologram:            unit.hologram ?? null,
      verification_status: verificationStatus,
      received_at:         unit.received_at,
      sold_at:             unit.sold_at ?? null,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
