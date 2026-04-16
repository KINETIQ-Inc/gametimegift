/**
 * GTG Edge Function — create-consultant
 *
 * Admin creation of a consultant profile (4C-1).
 * Inserts a new consultant_profiles row linked to an existing auth.users account.
 *
 * ─── What this endpoint does ──────────────────────────────────────────────────
 *
 * Creates the consultant_profiles record for a user who has already been
 * provisioned in auth.users (e.g., via Supabase Auth invite). The auth account
 * must exist before calling this endpoint.
 *
 * ─── What this endpoint does NOT do ──────────────────────────────────────────
 *
 * Tax onboarding (tax_id collection and tax_onboarding_complete flag) is a
 * separate, post-creation workflow handled by the consultant themselves.
 * This endpoint never accepts, logs, or returns tax_id — doing so would expose
 * the field to admin HTTP logs, which is a compliance violation.
 *
 * Running totals (lifetime_gross_sales_cents, lifetime_commissions_cents,
 * pending_payout_cents) are system-managed and never accepted from callers.
 *
 * ─── Commission tier rules ────────────────────────────────────────────────────
 *
 * commission_tier defaults to 'standard'. Valid values: standard, senior, elite,
 * custom. When commission_tier = 'custom', custom_commission_rate is required
 * (a decimal between 0 and 1 exclusive). For all other tiers, custom_commission_rate
 * must not be provided — the DB constraint enforces this.
 *
 * ─── referred_by ──────────────────────────────────────────────────────────────
 *
 * Optional UUID of the referring consultant's consultant_profiles.id (not
 * auth_user_id). Validated against the DB before insert to give a clear 400
 * rather than a FK violation.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/create-consultant
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "auth_user_id":          "<uuid>",          // required — existing auth.users.id
 *     "legal_first_name":      "Jane",            // required
 *     "legal_last_name":       "Smith",           // required
 *     "display_name":          "Jane S.",         // required
 *     "email":                 "jane@example.com",// required
 *     "phone":                 "+15551234567",    // optional
 *     "commission_tier":       "standard",        // optional; default standard
 *     "custom_commission_rate": 0.12,             // required iff commission_tier = custom
 *     "referred_by":           "<uuid>"           // optional; consultant_profiles.id
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   201 {
 *     "data": {
 *       "id":                         "<uuid>",
 *       "auth_user_id":               "<uuid>",
 *       "status":                     "pending_approval",
 *       "legal_first_name":           "Jane",
 *       "legal_last_name":            "Smith",
 *       "display_name":               "Jane S.",
 *       "email":                      "jane@example.com",
 *       "phone":                      null,
 *       "tax_onboarding_complete":    false,
 *       "address":                    null,
 *       "commission_tier":            "standard",
 *       "custom_commission_rate":     null,
 *       "referred_by":                null,
 *       "lifetime_gross_sales_cents": 0,
 *       "lifetime_commissions_cents": 0,
 *       "pending_payout_cents":       0,
 *       "status_changed_at":          null,
 *       "status_changed_by":          null,
 *       "created_at":                 "2026-03-06T...",
 *       "updated_at":                 "2026-03-06T..."
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure or business rule violation (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   404  auth_user_id or referred_by not found
 *   409  auth_user_id already has a consultant profile
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PG_UNIQUE_VIOLATION = '23505'

const VALID_TIERS    = new Set(['standard', 'senior', 'elite', 'custom'])
const STANDARD_TIERS = new Set(['standard', 'senior', 'elite'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  auth_user_id?:          string
  legal_first_name?:      string
  legal_last_name?:       string
  display_name?:          string
  email?:                 string
  phone?:                 string
  commission_tier?:       string
  custom_commission_rate?: number
  referred_by?:           string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('create-consultant', req)
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

    // ── Step 6: Validate required fields ────────────────────────────────────────

    if (!body.auth_user_id || !UUID_RE.test(body.auth_user_id)) {
      return jsonError(req, 'auth_user_id must be a valid UUID.', 400)
    }

    if (!body.legal_first_name || typeof body.legal_first_name !== 'string' ||
        body.legal_first_name.trim().length === 0) {
      return jsonError(req, 'legal_first_name is required.', 400)
    }

    if (!body.legal_last_name || typeof body.legal_last_name !== 'string' ||
        body.legal_last_name.trim().length === 0) {
      return jsonError(req, 'legal_last_name is required.', 400)
    }

    if (!body.display_name || typeof body.display_name !== 'string' ||
        body.display_name.trim().length === 0) {
      return jsonError(req, 'display_name is required.', 400)
    }

    if (!body.email || typeof body.email !== 'string' ||
        !EMAIL_RE.test(body.email.trim())) {
      return jsonError(req, 'email must be a valid email address.', 400)
    }

    if (body.phone !== undefined && body.phone !== null &&
        (typeof body.phone !== 'string' || body.phone.trim().length === 0)) {
      return jsonError(req, 'phone must be a non-empty string when provided.', 400)
    }

    // ── Step 7: Validate commission tier + custom rate ───────────────────────────

    const commissionTier = body.commission_tier ?? 'standard'

    if (!VALID_TIERS.has(commissionTier)) {
      return jsonError(
        req,
        "commission_tier must be one of: 'standard', 'senior', 'elite', 'custom'.",
        400,
      )
    }

    if (commissionTier === 'custom') {
      if (body.custom_commission_rate === undefined || body.custom_commission_rate === null) {
        return jsonError(
          req,
          "custom_commission_rate is required when commission_tier is 'custom'. " +
          'Provide a decimal rate between 0 and 1 exclusive (e.g. 0.12 for 12%).',
          400,
        )
      }
      if (typeof body.custom_commission_rate !== 'number' ||
          !isFinite(body.custom_commission_rate) ||
          body.custom_commission_rate <= 0 ||
          body.custom_commission_rate >= 1) {
        return jsonError(
          req,
          'custom_commission_rate must be a number strictly between 0 and 1 ' +
          '(e.g. 0.12 for 12%).',
          400,
        )
      }
    }

    if (STANDARD_TIERS.has(commissionTier) && body.custom_commission_rate !== undefined) {
      return jsonError(
        req,
        `custom_commission_rate must not be provided when commission_tier is '${commissionTier}'. ` +
        "custom_commission_rate is only valid for commission_tier = 'custom'.",
        400,
      )
    }

    // ── Step 8: Validate referred_by ────────────────────────────────────────────

    if (body.referred_by !== undefined && body.referred_by !== null) {
      if (!UUID_RE.test(body.referred_by)) {
        return jsonError(req, 'referred_by must be a valid UUID (consultant_profiles.id).', 400)
      }
    }

    const admin = createAdminClient()

    // ── Step 9: Verify auth_user_id exists in auth.users ────────────────────────

    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(
      body.auth_user_id,
    )

    if (authUserError !== null || authUser.user === null) {
      authedLog.warn('auth_user_id not found', { auth_user_id: body.auth_user_id })
      return jsonError(
        req,
        `auth.users record '${body.auth_user_id}' not found. ` +
        'The user must be provisioned in auth.users before creating a consultant profile.',
        404,
      )
    }

    // ── Step 10: Verify referred_by consultant exists ────────────────────────────

    if (body.referred_by) {
      const { data: referrer, error: referrerError } = await admin
        .from('consultant_profiles')
        .select('id')
        .eq('id', body.referred_by)
        .single()

      if (referrerError !== null || referrer === null) {
        authedLog.warn('referred_by consultant not found', { referred_by: body.referred_by })
        return jsonError(
          req,
          `Referring consultant '${body.referred_by}' not found. ` +
          'referred_by must be a valid consultant_profiles.id.',
          404,
        )
      }
    }

    // ── Step 11: Insert consultant profile ───────────────────────────────────────

    authedLog.info('Creating consultant profile', {
      auth_user_id:    body.auth_user_id,
      commission_tier: commissionTier,
      has_referrer:    !!body.referred_by,
    })

    const { data: profile, error: insertError } = await admin
      .from('consultant_profiles')
      .insert({
        auth_user_id:          body.auth_user_id,
        legal_first_name:      body.legal_first_name.trim(),
        legal_last_name:       body.legal_last_name.trim(),
        display_name:          body.display_name.trim(),
        email:                 body.email.trim().toLowerCase(),
        phone:                 body.phone?.trim() ?? null,
        commission_tier:       commissionTier,
        custom_commission_rate: commissionTier === 'custom'
          ? body.custom_commission_rate
          : null,
        referred_by:           body.referred_by ?? null,
      })
      .select(
        'id, auth_user_id, status, ' +
        'legal_first_name, legal_last_name, display_name, ' +
        'email, phone, ' +
        'tax_onboarding_complete, address, ' +
        'commission_tier, custom_commission_rate, referred_by, ' +
        'lifetime_gross_sales_cents, lifetime_commissions_cents, pending_payout_cents, ' +
        'status_changed_at, status_changed_by, ' +
        'created_at, updated_at',
      )
      .single()

    if (insertError !== null) {
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        authedLog.warn('Duplicate auth_user_id', { auth_user_id: body.auth_user_id })
        return jsonError(
          req,
          `A consultant profile already exists for auth_user_id '${body.auth_user_id}'. ` +
          'Each auth.users account may have at most one consultant profile.',
          409,
        )
      }
      authedLog.error('Insert failed', { error: insertError.message })
      return jsonError(req, 'Internal server error', 500)
    }

    authedLog.info('Consultant profile created', {
      id:              profile.id,
      auth_user_id:    profile.auth_user_id,
      commission_tier: profile.commission_tier,
    })

    return jsonResponse(req, profile, 201)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
