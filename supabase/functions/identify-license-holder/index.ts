/**
 * GTG Edge Function — identify-license-holder
 *
 * Resolves the license holder record for a royalty obligation, given either a
 * specific serialized unit or a license body code directly.
 *
 * ─── Purpose ─────────────────────────────────────────────────────────────────
 *
 * The Royalty Engine must know, for any given unit sale:
 *   1. Which external entity (CLC or U.S. Army) is owed royalties.
 *   2. What rate applies to that unit — captured at receive time.
 *   3. What the current default rate is — for comparison and audit.
 *   4. The minimum royalty floor and reporting cadence for the agreement.
 *
 * This function is the entry point for those answers. It is read-only —
 * no writes occur. Downstream royalty calculation (3C-2) and royalty entry
 * creation (3C-3) consume the output of this function.
 *
 * ─── Query modes ─────────────────────────────────────────────────────────────
 *
 * Exactly one of unit_id or license_body must be provided.
 *
 * MODE: by_unit
 *   Input: { unit_id: "uuid" }
 *   Fetches the unit's stamped license_body and royalty_rate, then resolves
 *   the active license_holder record for that body. Returns both the unit's
 *   historical rate (what the royalty was calculated at) and the current
 *   default rate (what a new unit of this type would carry today).
 *   Flags rate_matches_current = false when the two differ — which indicates
 *   a rate agreement changed after this unit was received. This flag is used
 *   by compliance reports to highlight units sold under an older rate.
 *
 * MODE: by_license_body
 *   Input: { license_body: "CLC" | "ARMY" | "NONE" }
 *   Resolves the active license_holder for the given body directly, without
 *   a unit context. Used by the royalty period aggregation flow (3C-2) when
 *   computing period totals across all units for a given body.
 *
 * ─── NONE license body ───────────────────────────────────────────────────────
 *
 * license_body = 'NONE' means the unit carries no royalty obligation (e.g.
 * unbranded or internally produced items). The function returns
 * royalty_applicable = false and license_holder = null for these units.
 * No license_holders row is expected or required for 'NONE'.
 *
 * ─── Rate mismatch ───────────────────────────────────────────────────────────
 *
 * When unit_royalty_rate (stamped at receive time) differs from the license
 * holder's current default_royalty_rate, rate_matches_current = false.
 * This is not an error — it is expected when rate agreements are updated.
 * The unit's stamped rate governs the royalty obligation for that specific sale;
 * the current rate governs new units received after the rate change.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * REPORTING_ROLES: super_admin, admin, licensor_auditor.
 * License holder contact details and rate agreements are compliance data —
 * not visible to consultants or customers.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/identify-license-holder
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   // By unit:
 *   { "unit_id": "uuid" }
 *
 *   // By license body:
 *   { "license_body": "CLC" }
 *
 * ─── Response: by_unit, CLC or ARMY unit ─────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "query_mode": "by_unit",
 *       "unit_id": "...",
 *       "serial_number": "GTG-ABC123",
 *       "sku": "GTG-001",
 *       "product_name": "Army Football Jersey #12",
 *       "license_body": "ARMY",
 *       "royalty_applicable": true,
 *       "unit_royalty_rate": 0.12,
 *       "rate_matches_current": false,
 *       "license_holder": {
 *         "id": "...",
 *         "legal_name": "U.S. Army Intellectual Property",
 *         "code": "ARMY-IPR",
 *         "contact_name": "Licensing Office",
 *         "contact_email": "licensing@army.mil",
 *         "default_royalty_rate": 0.15,
 *         "minimum_royalty_cents": 50000,
 *         "reporting_period": "monthly",
 *         "rate_effective_date": "2026-01-01",
 *         "rate_expiry_date": null,
 *         "is_active": true
 *       }
 *     }
 *   }
 *
 * ─── Response: by_unit, NONE unit ────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "query_mode": "by_unit",
 *       "unit_id": "...",
 *       "serial_number": "GTG-XYZ000",
 *       "sku": "GTG-999",
 *       "product_name": "Unbranded Training Cone",
 *       "license_body": "NONE",
 *       "royalty_applicable": false,
 *       "unit_royalty_rate": 0,
 *       "rate_matches_current": true,
 *       "license_holder": null
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (neither or both IDs provided, invalid license_body value)
 *   401  Unauthenticated
 *   403  Forbidden (role not in REPORTING_ROLES)
 *   404  Unit not found, or no active license_holder for the given body
 *   500  Internal server error
 */

import { REPORTING_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_LICENSE_BODIES = new Set(['CLC', 'ARMY', 'NONE'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  unit_id?:      string | null
  license_body?: string | null
}

interface LicenseHolderDetail {
  id:                   string
  legal_name:           string
  code:                 string
  contact_name:         string
  contact_email:        string
  default_royalty_rate: number
  minimum_royalty_cents: number | null
  reporting_period:     string
  rate_effective_date:  string
  rate_expiry_date:     string | null
  is_active:            boolean
}

interface ByUnitResponse {
  query_mode:           'by_unit'
  unit_id:              string
  serial_number:        string
  sku:                  string
  product_name:         string
  license_body:         string
  royalty_applicable:   boolean
  /** Rate stamped on the unit at receive time. 0 when license_body = 'NONE'. */
  unit_royalty_rate:    number
  /**
   * True when the unit's stamped rate equals the license holder's current
   * default_royalty_rate. False signals the unit was received under a
   * superseded rate agreement — the unit's stamped rate still governs.
   */
  rate_matches_current: boolean
  license_holder:       LicenseHolderDetail | null
}

interface ByLicenseBodyResponse {
  query_mode:          'by_license_body'
  license_body:        string
  royalty_applicable:  boolean
  license_holder:      LicenseHolderDetail | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('identify-license-holder', req)
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

    const { authorized, denied } = verifyRole(user, REPORTING_ROLES, req)
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

    const hasUnit = !!body.unit_id
    const hasBody = !!body.license_body

    if (!hasUnit && !hasBody) {
      return jsonError(req, 'Provide either unit_id or license_body', 400)
    }
    if (hasUnit && hasBody) {
      return jsonError(req, 'Provide either unit_id or license_body — not both', 400)
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    if (hasUnit && !uuidPattern.test(body.unit_id!)) {
      return jsonError(req, 'unit_id must be a valid UUID v4', 400)
    }

    if (hasBody && !VALID_LICENSE_BODIES.has(body.license_body!)) {
      return jsonError(
        req,
        `license_body must be one of: ${[...VALID_LICENSE_BODIES].join(', ')}`,
        400,
      )
    }

    const admin = createAdminClient()

    // ── Step 6: Route to query mode ───────────────────────────────────────────

    if (hasUnit) {
      return await handleByUnit(req, body.unit_id!, admin, authedLog)
    } else {
      return await handleByLicenseBody(req, body.license_body!, admin, authedLog)
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})

// ─── Query helpers ────────────────────────────────────────────────────────────

/** Fetch and return the active license_holder row for a given license_body. */
async function fetchActiveLicenseHolder(
  licenseBody: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ data: LicenseHolderDetail | null; notFound: boolean; error: boolean }> {
  if (licenseBody === 'NONE') {
    return { data: null, notFound: false, error: false }
  }

  const { data, error } = await admin
    .from('license_holders')
    .select(`
      id,
      legal_name,
      code,
      contact_name,
      contact_email,
      default_royalty_rate,
      minimum_royalty_cents,
      reporting_period,
      rate_effective_date,
      rate_expiry_date,
      is_active
    `)
    .eq('license_body', licenseBody)
    .eq('is_active', true)
    .order('rate_effective_date', { ascending: false })
    .limit(1)
    .single()

  if (error !== null) {
    if (error.code === 'PGRST116') {
      return { data: null, notFound: true, error: false }
    }
    return { data: null, notFound: false, error: true }
  }

  return {
    data: {
      id:                   data.id,
      legal_name:           data.legal_name,
      code:                 data.code,
      contact_name:         data.contact_name,
      contact_email:        data.contact_email,
      default_royalty_rate: Number(data.default_royalty_rate),
      minimum_royalty_cents: data.minimum_royalty_cents,
      reporting_period:     data.reporting_period,
      rate_effective_date:  data.rate_effective_date,
      rate_expiry_date:     data.rate_expiry_date,
      is_active:            data.is_active,
    },
    notFound: false,
    error: false,
  }
}

// ─── Mode: by_unit ────────────────────────────────────────────────────────────

async function handleByUnit(
  req: Request,
  unitId: string,
  admin: ReturnType<typeof createAdminClient>,
  log: { info: (m: string, c?: Record<string, unknown>) => void; warn: (m: string, c?: Record<string, unknown>) => void; error: (m: string, c?: Record<string, unknown>) => void },
): Promise<Response> {
  // Fetch the unit first to get its license_body and stamped royalty_rate.
  const { data: unit, error: unitError } = await admin
    .from('serialized_units')
    .select('id, serial_number, sku, product_name, license_body, royalty_rate')
    .eq('id', unitId)
    .single()

  if (unitError !== null) {
    if (unitError.code === 'PGRST116') {
      return jsonError(req, `Unit not found: ${unitId}`, 404)
    }
    log.error('DB error fetching unit', { unit_id: unitId, code: unitError.code })
    return jsonError(req, 'Internal server error', 500)
  }

  const licenseBody    = unit.license_body as string
  const unitRoyaltyRate = licenseBody === 'NONE' ? 0 : Number(unit.royalty_rate)
  const royaltyApplicable = licenseBody !== 'NONE'

  log.info('Unit fetched', {
    unit_id:      unitId,
    license_body: licenseBody,
    royalty_rate: unitRoyaltyRate,
  })

  // Fetch the active license holder for this body.
  const { data: holder, notFound, error: holderError } = await fetchActiveLicenseHolder(
    licenseBody,
    admin,
  )

  if (holderError) {
    log.error('DB error fetching license holder', { license_body: licenseBody })
    return jsonError(req, 'Internal server error', 500)
  }

  if (notFound) {
    return jsonError(
      req,
      `No active license_holder record found for license_body '${licenseBody}'. ` +
      `An admin must create an active license_holder row for this body before ` +
      `royalties can be calculated.`,
      404,
    )
  }

  // Rate match check: unit's stamped rate vs current default.
  // For NONE units, both rates are effectively 0 — always matches.
  const rateMatchesCurrent = holder === null
    ? true
    : unitRoyaltyRate === holder.default_royalty_rate

  if (!rateMatchesCurrent) {
    log.info('Rate mismatch detected', {
      unit_id:            unitId,
      unit_royalty_rate:  unitRoyaltyRate,
      current_rate:       holder!.default_royalty_rate,
      license_body:       licenseBody,
    })
  }

  const payload: ByUnitResponse = {
    query_mode:           'by_unit',
    unit_id:              unit.id,
    serial_number:        unit.serial_number,
    sku:                  unit.sku,
    product_name:         unit.product_name,
    license_body:         licenseBody,
    royalty_applicable:   royaltyApplicable,
    unit_royalty_rate:    unitRoyaltyRate,
    rate_matches_current: rateMatchesCurrent,
    license_holder:       holder,
  }

  return jsonResponse(req, payload)
}

// ─── Mode: by_license_body ────────────────────────────────────────────────────

async function handleByLicenseBody(
  req: Request,
  licenseBody: string,
  admin: ReturnType<typeof createAdminClient>,
  log: { info: (m: string, c?: Record<string, unknown>) => void; warn: (m: string, c?: Record<string, unknown>) => void; error: (m: string, c?: Record<string, unknown>) => void },
): Promise<Response> {
  const royaltyApplicable = licenseBody !== 'NONE'

  log.info('Resolving license holder', { license_body: licenseBody })

  if (!royaltyApplicable) {
    // 'NONE' — no license holder exists or is needed.
    const payload: ByLicenseBodyResponse = {
      query_mode:         'by_license_body',
      license_body:       licenseBody,
      royalty_applicable: false,
      license_holder:     null,
    }
    return jsonResponse(req, payload)
  }

  const { data: holder, notFound, error: holderError } = await fetchActiveLicenseHolder(
    licenseBody,
    admin,
  )

  if (holderError) {
    log.error('DB error fetching license holder', { license_body: licenseBody })
    return jsonError(req, 'Internal server error', 500)
  }

  if (notFound) {
    return jsonError(
      req,
      `No active license_holder record found for license_body '${licenseBody}'. ` +
      `An admin must create an active license_holder row before royalties can be calculated.`,
      404,
    )
  }

  log.info('License holder resolved', {
    license_body: licenseBody,
    holder_id:    holder!.id,
    code:         holder!.code,
  })

  const payload: ByLicenseBodyResponse = {
    query_mode:         'by_license_body',
    license_body:       licenseBody,
    royalty_applicable: true,
    license_holder:     holder,
  }

  return jsonResponse(req, payload)
}
