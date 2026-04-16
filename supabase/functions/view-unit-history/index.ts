/**
 * GTG Edge Function — view-unit-history
 *
 * Complete audit trail for a single serialized unit (4B-3).
 * Read-only — no writes. Returns the full lifecycle history of one unit
 * assembled from four tables in parallel:
 *
 *   ledger        inventory_ledger_entries   every state-change event
 *   fraud_flags   fraud_flags                investigation records
 *   lock_records  lock_records               enforcement locks (scope = 'unit')
 *   commission    commission_entries         commission earned on this unit
 *
 * ─── Ledger entries ───────────────────────────────────────────────────────────
 *
 * Ordered chronologically (occurred_at ASC). The first entry is always
 * action = 'received'. Subsequent entries record every state transition:
 * hologram_applied, reserved, reservation_released, sold, returned,
 * fraud_locked, fraud_released, voided.
 *
 * from_status is null only for the 'received' entry. All other entries carry
 * both from_status and to_status, providing the complete state machine trace.
 *
 * ─── Fraud flags ──────────────────────────────────────────────────────────────
 *
 * All fraud flags ever raised for this unit, ordered by created_at ASC.
 * Includes full investigation detail: source, severity, status, actor UUIDs,
 * investigation_notes, resolution_note, and signal_metadata JSONB.
 *
 * Flags are independent of locks — a flag may exist without a lock (low/medium
 * severity) and a lock may exist without a flag (licensor-mandated lock).
 *
 * ─── Lock records ─────────────────────────────────────────────────────────────
 *
 * All lock_records with scope = 'unit' and target_id = unit.id, ordered
 * by locked_at ASC. Includes full authority chain: lock_authority,
 * licensor_reference_id, release fields. is_active = true = currently locked.
 *
 * ─── Commission ───────────────────────────────────────────────────────────────
 *
 * Commission entry for this unit (at most one, due to the unique constraint
 * on commission_entries.unit_id). Null when no commission was generated
 * (direct/admin sale, or unit never sold).
 *
 * ─── Lookup modes ─────────────────────────────────────────────────────────────
 *
 * By unit_id (UUID) or serial_number. Mutually exclusive. The unit snapshot
 * is fetched first; history queries run against its resolved unit_id.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Unit history includes fraud investigation details and financial linkage.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/view-unit-history
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   By unit ID:      { "unit_id":      "<uuid>" }
 *   By serial number: { "serial_number": "GTG-CLC-2026-0001" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "unit": {
 *         "id":                 "<uuid>",
 *         "serial_number":      "GTG-CLC-2026-0001",
 *         "sku":                "APP-NIKE-JERSEY-M",
 *         "product_id":         "<uuid>",
 *         "product_name":       "Nike Jersey — Medium",
 *         "batch_id":           "<uuid>",
 *         "status":             "sold",
 *         "license_body":       "CLC",
 *         "royalty_rate":       0.145,
 *         "cost_cents":         2499,
 *         "retail_price_cents": 4999,
 *         "order_id":           "<uuid>",
 *         "consultant_id":      "<uuid>",
 *         "hologram":           { ... },
 *         "received_at":        "2026-03-06T...",
 *         "sold_at":            "2026-03-07T...",
 *         "returned_at":        null,
 *         "fraud_locked_at":    null,
 *         "fraud_locked_by":    null,
 *         "fraud_lock_reason":  null,
 *         "updated_at":         "2026-03-07T...",
 *         "batch": {
 *           "batch_number":          "BATCH-20260306-CLC-001",
 *           "purchase_order_number": "PO-2026-0042",
 *           "expected_unit_count":   100,
 *           "received_unit_count":   97
 *         }
 *       },
 *       "ledger": [
 *         {
 *           "id":                 "<uuid>",
 *           "action":             "received",
 *           "from_status":        null,
 *           "to_status":          "available",
 *           "performed_by":       "<uuid>",
 *           "order_id":           null,
 *           "consultant_id":      null,
 *           "license_body":       "CLC",
 *           "royalty_rate":       0.145,
 *           "retail_price_cents": null,
 *           "reason":             null,
 *           "metadata":           null,
 *           "occurred_at":        "2026-03-06T..."
 *         },
 *         {
 *           "action":             "sold",
 *           "from_status":        "available",
 *           "to_status":          "sold",
 *           "retail_price_cents": 4999,
 *           ...
 *         }
 *       ],
 *       "fraud_flags": [],
 *       "lock_records": [],
 *       "commission": {
 *         "id":               "<uuid>",
 *         "consultant_id":    "<uuid>",
 *         "commission_tier":  "standard",
 *         "commission_rate":  0.10,
 *         "commission_cents": 499,
 *         "status":           "approved",
 *         "created_at":       "2026-03-07T..."
 *       }
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Unit not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Unit snapshot selector — same as view-unit-status for consistency
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
  unit_id?:      string
  serial_number?: string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('view-unit-history', req)
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

    const hasByUnitId = body.unit_id      !== undefined
    const hasBySerial = body.serial_number !== undefined

    if (!hasByUnitId && !hasBySerial) {
      return jsonError(
        req,
        "Provide either 'unit_id' (UUID) or 'serial_number' to identify the unit.",
        400,
      )
    }

    if (hasByUnitId && hasBySerial) {
      return jsonError(
        req,
        "Provide either 'unit_id' or 'serial_number', not both.",
        400,
      )
    }

    if (hasByUnitId && !UUID_RE.test(body.unit_id!)) {
      return jsonError(req, 'unit_id must be a valid UUID.', 400)
    }

    if (hasBySerial && (typeof body.serial_number !== 'string' ||
        body.serial_number.trim().length === 0)) {
      return jsonError(req, 'serial_number must be a non-empty string.', 400)
    }

    // ── Step 6: Fetch unit snapshot ─────────────────────────────────────────────

    const admin = createAdminClient()

    const lookup = hasByUnitId
      ? { column: 'id',            value: body.unit_id! }
      : { column: 'serial_number', value: body.serial_number!.trim() }

    authedLog.info('Fetching unit', { mode: hasByUnitId ? 'by_id' : 'by_serial', value: lookup.value })

    const { data: unit, error: unitError } = await admin
      .from('serialized_units')
      .select(UNIT_SELECT)
      .eq(lookup.column, lookup.value)
      .single()

    if (unitError !== null) {
      if (unitError.code === 'PGRST116') {
        authedLog.warn('Unit not found', { [lookup.column]: lookup.value })
        return jsonError(
          req,
          hasByUnitId
            ? `Unit '${body.unit_id}' not found.`
            : `No unit found with serial_number '${body.serial_number}'.`,
          404,
        )
      }
      authedLog.error('Unit fetch failed', { error: unitError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const unitId: string = unit.id

    // ── Step 7: Fetch history tables in parallel ────────────────────────────────
    //
    // All four tables are indexed on unit_id. Running them concurrently via
    // Promise.all halves the DB round-trip count vs. sequential queries.

    const [ledgerRes, flagsRes, locksRes, commissionRes] = await Promise.all([

      // Ledger entries — chronological state-change timeline
      admin
        .from('inventory_ledger_entries')
        .select(
          'id, action, from_status, to_status, performed_by, ' +
          'order_id, consultant_id, license_body, royalty_rate, ' +
          'retail_price_cents, reason, metadata, occurred_at',
        )
        .eq('unit_id', unitId)
        .order('occurred_at', { ascending: true }),

      // Fraud flags — investigation records
      admin
        .from('fraud_flags')
        .select(
          'id, source, severity, status, unit_status_at_flag, ' +
          'auto_locked, auto_lock_id, related_order_id, related_consultant_id, ' +
          'reporting_licensor, signal_metadata, description, ' +
          'raised_by, assigned_to, assigned_at, ' +
          'investigation_notes, escalation_reason, ' +
          'resolution_note, resolved_at, resolved_by, ' +
          'created_at, updated_at',
        )
        .eq('unit_id', unitId)
        .order('created_at', { ascending: true }),

      // Lock records — enforcement locks for this unit
      // target_id is stored as text; unit.id is a UUID string — comparison is safe
      admin
        .from('lock_records')
        .select(
          'id, fraud_flag_id, scope, target_id, target_label, ' +
          'lock_authority, status_before_lock, is_active, ' +
          'lock_reason, licensor_reference_id, ' +
          'locked_by, locked_at, ' +
          'release_reason, release_authority, release_reference_id, ' +
          'released_by, released_at, ' +
          'created_at, updated_at',
        )
        .eq('scope', 'unit')
        .eq('target_id', unitId)
        .order('locked_at', { ascending: true }),

      // Commission entry — at most one per unit (unique constraint)
      admin
        .from('commission_entries')
        .select(
          'id, consultant_id, consultant_name, order_id, ' +
          'serial_number, sku, product_name, ' +
          'retail_price_cents, commission_tier, commission_rate, commission_cents, ' +
          'status, hold_reason, reversal_reason, ' +
          'payout_batch_id, approved_at, paid_at, reversed_at, ' +
          'created_at, updated_at',
        )
        .eq('unit_id', unitId),
    ])

    // ── Step 8: Handle query errors ─────────────────────────────────────────────

    if (ledgerRes.error !== null) {
      authedLog.error('Ledger query failed', { error: ledgerRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }
    if (flagsRes.error !== null) {
      authedLog.error('Fraud flags query failed', { error: flagsRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }
    if (locksRes.error !== null) {
      authedLog.error('Lock records query failed', { error: locksRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }
    if (commissionRes.error !== null) {
      authedLog.error('Commission query failed', { error: commissionRes.error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    // ── Step 9: Assemble and return ─────────────────────────────────────────────

    // Commission: unique constraint means 0 or 1 rows — surface as object or null
    const commissionRows = commissionRes.data ?? []
    const commission     = commissionRows.length > 0 ? commissionRows[0] : null

    authedLog.info('History assembled', {
      unit_id:           unitId,
      serial_number:     unit.serial_number,
      status:            unit.status,
      ledger_entries:    ledgerRes.data?.length ?? 0,
      fraud_flags:       flagsRes.data?.length  ?? 0,
      lock_records:      locksRes.data?.length  ?? 0,
      has_commission:    commission !== null,
    })

    return jsonResponse(req, {
      unit,
      ledger:       ledgerRes.data  ?? [],
      fraud_flags:  flagsRes.data   ?? [],
      lock_records: locksRes.data   ?? [],
      commission,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
