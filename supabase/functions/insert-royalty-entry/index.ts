/**
 * GTG Edge Function — insert-royalty-entry
 *
 * Persists a calculated royalty obligation into royalty_entries.
 * This is the write step of the 3C royalty pipeline — it consumes the output
 * of calculate-royalty (3C-2) and calls the create_royalty_entry DB function
 * to produce a durable, auditable record.
 *
 * ─── Pipeline position ────────────────────────────────────────────────────────
 *
 *   3C-1  identify-license-holder   resolve the active holder for a body
 *   3C-2  calculate-royalty         compute period totals (read-only)
 *   3C-3  insert-royalty-entry  ←── write the calculated entry (this function)
 *
 * ─── What this function does ──────────────────────────────────────────────────
 *
 * 1. Validates the input shape — all fields required by royalty_entries,
 *    derived directly from the calculate-royalty response.
 *
 * 2. Guards against zero-sale submissions. A period with units_sold = 0
 *    produces no royalty entry (royalty_entries requires units_sold > 0).
 *    If a minimum royalty obligation exists for a zero-sale period, that
 *    must be handled through a manual admin process, not this function.
 *
 * 3. Calls the create_royalty_entry DB function, which:
 *    - Re-validates the license_holder is still active (race guard)
 *    - Inserts the entry at status = 'calculated'
 *    - Is idempotent: returns the existing entry if already inserted
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Re-submitting the same (license_holder_id, period_start, period_end) returns
 * the existing entry with was_created = false. This allows safe retries without
 * duplicating entries. The caller should inspect was_created = false and confirm
 * the existing entry matches the intended calculation before proceeding.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Licensor auditors (licensor_auditor) have read-only access via calculate-royalty
 * and commission-summary — they do not write ledger entries.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/insert-royalty-entry
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   Fields map directly from the calculate-royalty response:
 *   {
 *     "license_body":        "CLC",
 *     "period_start":        "2026-01-01",
 *     "period_end":          "2026-03-31",
 *     "license_holder_id":   "<uuid>",          // calculate-royalty.license_holder.id
 *     "license_holder_name": "Collegiate ...",   // calculate-royalty.license_holder.legal_name
 *     "reporting_period":    "quarterly",        // calculate-royalty.license_holder.reporting_period
 *     "units_sold":          42,
 *     "gross_sales_cents":   209958,
 *     "royalty_rate":        0.145,
 *     "royalty_cents":       30444,
 *     "remittance_cents":    30444,
 *     "minimum_applied":     false,
 *     "ledger_entry_ids":    ["<uuid>", ...]     // must match units_sold in length
 *   }
 *
 * ─── Response: created ───────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "royalty_entry_id": "<uuid>",
 *       "was_created":      true,
 *       "license_body":     "CLC",
 *       "period_start":     "2026-01-01",
 *       "period_end":       "2026-03-31",
 *       "remittance_cents": 30444
 *     }
 *   }
 *
 * ─── Response: already existed (idempotent) ──────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "royalty_entry_id": "<uuid>",
 *       "was_created":      false,
 *       ...
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (invalid fields, zero units_sold, period order, rate bounds)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   500  Internal server error / DB error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_ROYALTY_BODIES    = new Set(['CLC', 'ARMY'])
const VALID_REPORTING_PERIODS = new Set(['monthly', 'quarterly', 'annual'])
const ISO_DATE                = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE                 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  license_body:        string
  period_start:        string
  period_end:          string
  license_holder_id:   string
  license_holder_name: string
  reporting_period:    string
  units_sold:          number
  gross_sales_cents:   number
  royalty_rate:        number
  royalty_cents:       number
  remittance_cents:    number
  minimum_applied:     boolean
  ledger_entry_ids:    string[]
}

interface ResponsePayload {
  royalty_entry_id: string
  was_created:      boolean
  license_body:     string
  period_start:     string
  period_end:       string
  remittance_cents: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('insert-royalty-entry', req)
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

    // license_body
    if (!body.license_body || !VALID_ROYALTY_BODIES.has(body.license_body)) {
      return jsonError(
        req,
        `license_body must be one of: ${[...VALID_ROYALTY_BODIES].join(', ')}. ` +
        `'NONE' bodies carry no royalty obligation and cannot be stored.`,
        400,
      )
    }

    // Dates
    if (!body.period_start || !ISO_DATE.test(body.period_start)) {
      return jsonError(req, 'period_start must be an ISO 8601 date (YYYY-MM-DD).', 400)
    }
    if (!body.period_end || !ISO_DATE.test(body.period_end)) {
      return jsonError(req, 'period_end must be an ISO 8601 date (YYYY-MM-DD).', 400)
    }
    if (body.period_end < body.period_start) {
      return jsonError(req, 'period_end must be on or after period_start.', 400)
    }

    // license_holder_id
    if (!body.license_holder_id || !UUID_RE.test(body.license_holder_id)) {
      return jsonError(req, 'license_holder_id must be a valid UUID.', 400)
    }

    // license_holder_name
    if (!body.license_holder_name || typeof body.license_holder_name !== 'string') {
      return jsonError(req, 'license_holder_name is required.', 400)
    }

    // reporting_period
    if (!body.reporting_period || !VALID_REPORTING_PERIODS.has(body.reporting_period)) {
      return jsonError(
        req,
        `reporting_period must be one of: ${[...VALID_REPORTING_PERIODS].join(', ')}.`,
        400,
      )
    }

    // units_sold — must be a positive integer
    if (!Number.isInteger(body.units_sold) || body.units_sold <= 0) {
      return jsonError(
        req,
        'units_sold must be a positive integer. ' +
        'Zero-sale periods do not generate a royalty entry — ' +
        'minimum royalty obligations for periods with no sales require manual admin review.',
        400,
      )
    }

    // gross_sales_cents
    if (!Number.isInteger(body.gross_sales_cents) || body.gross_sales_cents < 0) {
      return jsonError(req, 'gross_sales_cents must be a non-negative integer.', 400)
    }

    // royalty_rate
    if (typeof body.royalty_rate !== 'number' || body.royalty_rate <= 0 || body.royalty_rate > 1) {
      return jsonError(req, 'royalty_rate must be a number > 0 and <= 1.', 400)
    }

    // royalty_cents
    if (!Number.isInteger(body.royalty_cents) || body.royalty_cents < 0) {
      return jsonError(req, 'royalty_cents must be a non-negative integer.', 400)
    }

    // remittance_cents — minimum floor ensures this >= royalty_cents
    if (!Number.isInteger(body.remittance_cents) || body.remittance_cents < body.royalty_cents) {
      return jsonError(req, 'remittance_cents must be an integer >= royalty_cents.', 400)
    }

    // minimum_applied
    if (typeof body.minimum_applied !== 'boolean') {
      return jsonError(req, 'minimum_applied must be a boolean.', 400)
    }

    // ledger_entry_ids — non-empty, all valid UUIDs, length must equal units_sold
    if (!Array.isArray(body.ledger_entry_ids) || body.ledger_entry_ids.length === 0) {
      return jsonError(req, 'ledger_entry_ids must be a non-empty array of UUIDs.', 400)
    }

    const invalidId = body.ledger_entry_ids.find(
      (id) => typeof id !== 'string' || !UUID_RE.test(id),
    )
    if (invalidId !== undefined) {
      return jsonError(req, `ledger_entry_ids contains an invalid UUID: ${String(invalidId)}.`, 400)
    }

    if (body.ledger_entry_ids.length !== body.units_sold) {
      return jsonError(
        req,
        `ledger_entry_ids length (${body.ledger_entry_ids.length}) must match ` +
        `units_sold (${body.units_sold}). Each sold ledger entry must be listed exactly once.`,
        400,
      )
    }

    // ── Step 6: Insert royalty entry ─────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Inserting royalty entry', {
      license_body:    body.license_body,
      period_start:    body.period_start,
      period_end:      body.period_end,
      units_sold:      body.units_sold,
      royalty_cents:   body.royalty_cents,
      remittance_cents: body.remittance_cents,
      minimum_applied: body.minimum_applied,
    })

    const { data: rpcRows, error: rpcError } = await admin.rpc('create_royalty_entry', {
      p_license_body:          body.license_body,
      p_period_start:          body.period_start,
      p_period_end:            body.period_end,
      p_license_holder_id:     body.license_holder_id,
      p_license_holder_name:   body.license_holder_name,
      p_reporting_period:      body.reporting_period,
      p_units_sold:            body.units_sold,
      p_gross_sales_cents:     body.gross_sales_cents,
      p_royalty_rate:          body.royalty_rate,
      p_royalty_cents:         body.royalty_cents,
      p_remittance_cents:      body.remittance_cents,
      p_minimum_applied:       body.minimum_applied,
      p_ledger_entry_ids:      body.ledger_entry_ids,
      p_created_by:            authorized.id,
    })

    if (rpcError !== null) {
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('create_royalty_entry failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Failed to insert royalty entry.', 400)
    }

    const row = (rpcRows as Array<{ royalty_entry_id: string; was_created: boolean }>)[0]!

    if (row.was_created) {
      authedLog.info('Royalty entry created', {
        royalty_entry_id: row.royalty_entry_id,
        license_body:     body.license_body,
        period_start:     body.period_start,
        period_end:       body.period_end,
        remittance_cents: body.remittance_cents,
      })
    } else {
      authedLog.info('Royalty entry already exists — idempotent re-insert', {
        royalty_entry_id: row.royalty_entry_id,
        license_body:     body.license_body,
        period_start:     body.period_start,
        period_end:       body.period_end,
      })
    }

    return jsonResponse(req, {
      royalty_entry_id: row.royalty_entry_id,
      was_created:      row.was_created,
      license_body:     body.license_body,
      period_start:     body.period_start,
      period_end:       body.period_end,
      remittance_cents: body.remittance_cents,
    } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
