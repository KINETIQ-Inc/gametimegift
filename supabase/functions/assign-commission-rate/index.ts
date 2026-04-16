/**
 * GTG Edge Function — assign-commission-rate
 *
 * Admin assignment of a commission tier and rate to a consultant (4C-2).
 * Updates consultant_profiles.commission_tier and custom_commission_rate.
 *
 * ─── What this endpoint does ──────────────────────────────────────────────────
 *
 * Changes a consultant's commission tier. The tier determines which rate from
 * commission_tier_config is applied at sale time. For the 'custom' tier, a
 * specific rate is stored directly on the consultant profile.
 *
 * This is distinct from set-commission-tier-rates (4A-4), which manages the
 * platform-wide rate table for standard/senior/elite tiers. This endpoint
 * assigns a tier (or custom rate) to an individual consultant.
 *
 * ─── Commission tier rules ────────────────────────────────────────────────────
 *
 * Valid tiers: standard, senior, elite, custom.
 *
 *   standard / senior / elite — Rate is read from commission_tier_config at sale
 *     time. custom_commission_rate must NOT be provided for these tiers.
 *
 *   custom — Rate is stored on the consultant profile. custom_commission_rate is
 *     required: a decimal strictly between 0 and 1 (e.g. 0.12 for 12%).
 *     When switching from 'custom' to a standard tier, the stored rate is cleared.
 *
 * ─── Effect on future commissions ─────────────────────────────────────────────
 *
 * The tier change takes effect immediately. Commissions on sales that have
 * already been created are NOT retroactively recalculated — commission_entries
 * snapshot the tier and rate at sale time.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/assign-commission-rate
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   Standard tier:
 *   {
 *     "consultant_id":   "<uuid>",    // consultant_profiles.id
 *     "commission_tier": "senior"
 *   }
 *
 *   Custom rate:
 *   {
 *     "consultant_id":          "<uuid>",
 *     "commission_tier":        "custom",
 *     "custom_commission_rate": 0.14    // required for custom tier
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "consultant_id":          "<uuid>",
 *       "display_name":           "Jane S.",
 *       "commission_tier":        "custom",
 *       "custom_commission_rate": 0.14,
 *       "previous_tier":          "standard",
 *       "previous_rate":          null
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or business rule violation (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  Consultant not found
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_TIERS    = new Set(['standard', 'senior', 'elite', 'custom'])
const STANDARD_TIERS = new Set(['standard', 'senior', 'elite'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id?:          string
  commission_tier?:        string
  custom_commission_rate?: number
}

interface ConsultantRow {
  id:                     string
  display_name:           string
  commission_tier:        string
  custom_commission_rate: number | null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('assign-commission-rate', req)
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

    // ── Step 6: Validate fields ─────────────────────────────────────────────────

    if (!body.consultant_id || !UUID_RE.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID.', 400)
    }

    if (!body.commission_tier || typeof body.commission_tier !== 'string') {
      return jsonError(req, 'commission_tier is required.', 400)
    }

    if (!VALID_TIERS.has(body.commission_tier)) {
      return jsonError(
        req,
        "commission_tier must be one of: 'standard', 'senior', 'elite', 'custom'.",
        400,
      )
    }

    if (body.commission_tier === 'custom') {
      if (body.custom_commission_rate === undefined || body.custom_commission_rate === null) {
        return jsonError(
          req,
          "custom_commission_rate is required when commission_tier is 'custom'. " +
          'Provide a decimal rate strictly between 0 and 1 (e.g. 0.14 for 14%).',
          400,
        )
      }
      if (
        typeof body.custom_commission_rate !== 'number' ||
        !isFinite(body.custom_commission_rate) ||
        body.custom_commission_rate <= 0 ||
        body.custom_commission_rate >= 1
      ) {
        return jsonError(
          req,
          'custom_commission_rate must be a number strictly between 0 and 1 ' +
          '(e.g. 0.14 for 14%).',
          400,
        )
      }
    }

    if (STANDARD_TIERS.has(body.commission_tier) && body.custom_commission_rate !== undefined) {
      return jsonError(
        req,
        `custom_commission_rate must not be provided when commission_tier is '${body.commission_tier}'. ` +
        "custom_commission_rate is only valid for commission_tier = 'custom'.",
        400,
      )
    }

    const admin = createAdminClient()

    // ── Step 7: Pre-flight — fetch current consultant ───────────────────────────

    authedLog.info('Fetching consultant', { consultant_id: body.consultant_id })

    const { data: current, error: fetchError } = await admin
      .from('consultant_profiles')
      .select('id, display_name, commission_tier, custom_commission_rate')
      .eq('id', body.consultant_id)
      .single()

    if (fetchError !== null || current === null) {
      authedLog.warn('Consultant not found', { consultant_id: body.consultant_id })
      return jsonError(req, `Consultant '${body.consultant_id}' not found.`, 404)
    }

    const consultant = current as ConsultantRow

    // ── Step 8: Short-circuit if no change ─────────────────────────────────────

    const newRate = body.commission_tier === 'custom' ? body.custom_commission_rate! : null

    if (
      consultant.commission_tier === body.commission_tier &&
      consultant.custom_commission_rate === (newRate ?? null)
    ) {
      authedLog.info('No change — tier and rate already match', {
        consultant_id:    body.consultant_id,
        commission_tier:  body.commission_tier,
      })
      return jsonResponse(req, {
        consultant_id:          consultant.id,
        display_name:           consultant.display_name,
        commission_tier:        consultant.commission_tier,
        custom_commission_rate: consultant.custom_commission_rate,
        previous_tier:          consultant.commission_tier,
        previous_rate:          consultant.custom_commission_rate,
      })
    }

    // ── Step 9: Apply update ────────────────────────────────────────────────────

    authedLog.info('Assigning commission rate', {
      consultant_id:          body.consultant_id,
      previous_tier:          consultant.commission_tier,
      new_tier:               body.commission_tier,
      has_custom_rate:        body.commission_tier === 'custom',
    })

    const { data: updated, error: updateError } = await admin
      .from('consultant_profiles')
      .update({
        commission_tier:        body.commission_tier,
        // Explicitly null for standard tiers — clears any previously stored custom rate
        custom_commission_rate: newRate,
      })
      .eq('id', body.consultant_id)
      .select('id, display_name, commission_tier, custom_commission_rate')
      .single()

    if (updateError !== null) {
      authedLog.error('Update failed', { error: updateError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    const result = updated as ConsultantRow

    authedLog.info('Commission rate assigned', {
      consultant_id:          result.id,
      commission_tier:        result.commission_tier,
      has_custom_rate:        result.custom_commission_rate !== null,
    })

    return jsonResponse(req, {
      consultant_id:          result.id,
      display_name:           result.display_name,
      commission_tier:        result.commission_tier,
      custom_commission_rate: result.custom_commission_rate,
      previous_tier:          consultant.commission_tier,
      previous_rate:          consultant.custom_commission_rate,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
