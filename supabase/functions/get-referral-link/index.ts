/**
 * GTG Edge Function — get-referral-link
 *
 * Returns a consultant's unique referral link for customer sharing (6A-1).
 * The link encodes the consultant's referral_code as a URL query parameter.
 * When a customer visits the link and completes a purchase, the checkout
 * session attributes the order to this consultant via consultant_id.
 *
 * ─── Referral link mechanics ──────────────────────────────────────────────────
 *
 * Referral code (e.g. SMITHA3F2) is stored on consultant_profiles.referral_code.
 * The referral link is: ${STOREFRONT_URL}/shop?ref=<referral_code>
 *
 * The storefront resolves the ref code to a consultant_profiles.id, then passes
 * that id as consultant_id when calling create-checkout-session (5B-1).
 *
 * ─── On-demand code generation ────────────────────────────────────────────────
 *
 * Consultants created before migration 39 (which added the referral_code column)
 * will have referral_code = null. This endpoint detects that condition and calls
 * generate_referral_code to create and persist the code before returning the link.
 * All subsequent calls return the persisted code instantly.
 *
 * ─── Attribution summary ──────────────────────────────────────────────────────
 *
 * The response includes a lightweight attribution summary drawn from the
 * orders table: total orders attributed to this consultant and their lifetime
 * gross sales total. These are the same figures as lifetime_gross_sales_cents
 * on the consultant profile — included here for convenience so the consultant
 * dashboard can display referral performance alongside the link itself.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * Allowed roles: consultant (own link only), admin, super_admin (any consultant).
 *
 * Consultants retrieve their own link using their JWT — no input required.
 * Admins may retrieve any consultant's link by passing consultant_id in the body.
 *
 * ─── Environment ──────────────────────────────────────────────────────────────
 *
 *   STOREFRONT_URL   Base URL of the public storefront (e.g. https://gametimegift.com).
 *                    The referral link is constructed as: ${STOREFRONT_URL}/shop?ref=<code>
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/get-referral-link
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *
 *   Consultant (own link — body may be empty):
 *   {}
 *
 *   Admin (any consultant):
 *   { "consultant_id": "<uuid>" }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "consultant_id":          "<uuid>",
 *       "display_name":           "Jane S.",
 *       "referral_code":          "SMITHA3F2",
 *       "referral_url":           "https://gametimegift.com/shop?ref=SMITHA3F2",
 *       "share_text":             "Shop licensed GTG gear through my link: https://...",
 *       "lifetime_gross_sales_cents": 184900,
 *       "lifetime_commissions_cents": 27735,
 *       "total_referred_orders":  12
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (invalid consultant_id format)
 *   401  Unauthenticated
 *   403  Forbidden (non-consultant / non-admin role)
 *   404  Consultant profile not found
 *   500  Internal server error (including referral code generation failure)
 */

import { ADMIN_ROLES, extractRole, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFERRAL_PATH = '/shop?ref='

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id?: unknown
}

interface ConsultantRow {
  id:                         string
  display_name:               string
  legal_last_name:            string
  referral_code:              string | null
  lifetime_gross_sales_cents: number
  lifetime_commissions_cents: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('get-referral-link', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ───────────────────────────────────────────────────

    const role    = extractRole(user)
    const isAdmin = role === 'admin' || role === 'super_admin'

    if (role !== 'consultant' && !isAdmin) {
      log.warn('Forbidden role', { user_id: user.id, role })
      const { denied } = verifyRole(user, [...ADMIN_ROLES, 'consultant'], req)
      return denied!
    }

    const authedLog = log.withUser(user.id)
    authedLog.info('Authenticated', { role })

    // ── Step 5: Parse body ──────────────────────────────────────────────────

    let body: RequestBody = {}
    try {
      body = await req.json() as RequestBody
    } catch {
      // Empty body is valid — consultants omit it when retrieving their own link.
    }

    // Admin may pass consultant_id to retrieve any consultant's link.
    // Consultants always retrieve their own — consultant_id in body is ignored.
    if (body.consultant_id !== undefined && !isAdmin) {
      authedLog.warn('Consultant attempted to retrieve another consultant referral link')
      body = {}
    }

    if (body.consultant_id !== undefined && body.consultant_id !== null) {
      if (typeof body.consultant_id !== 'string' || !UUID_RE.test(body.consultant_id)) {
        return jsonError(req, 'consultant_id must be a valid UUID when provided.', 400)
      }
    }

    // ── Step 6: Resolve which consultant profile to fetch ───────────────────

    const admin = createAdminClient()

    let profileQuery = admin
      .from('consultant_profiles')
      .select('id, display_name, legal_last_name, referral_code, lifetime_gross_sales_cents, lifetime_commissions_cents')

    if (isAdmin && body.consultant_id) {
      // Admin requested a specific consultant by profile ID.
      profileQuery = profileQuery.eq('id', body.consultant_id as string)
    } else {
      // Consultant (or admin without explicit consultant_id): resolve via auth user.
      profileQuery = profileQuery.eq('auth_user_id', user.id)
    }

    const { data: profileData, error: profileError } = await profileQuery.single()

    if (profileError !== null || profileData === null) {
      authedLog.warn('Consultant profile not found', {
        error:         profileError?.message,
        consultant_id: body.consultant_id ?? '(own)',
      })
      return jsonError(req, 'Consultant profile not found.', 404)
    }

    const profile = profileData as ConsultantRow

    // ── Step 7: Generate referral code if missing ────────────────────────────
    // Consultants created before migration 39 have referral_code = null.
    // Call generate_referral_code, persist the result, then continue.

    let referralCode = profile.referral_code

    if (referralCode === null) {
      authedLog.info('Referral code missing; generating now', { consultant_id: profile.id })

      const { data: generatedCode, error: generateError } = await admin.rpc(
        'generate_referral_code',
        {
          p_last_name: profile.legal_last_name,
          p_id:        profile.id,
        },
      )

      if (generateError !== null || !generatedCode) {
        authedLog.error('Referral code generation failed', { error: generateError?.message })
        return jsonError(req, 'Internal server error', 500)
      }

      referralCode = generatedCode as string

      // Persist the generated code so future calls are instant.
      const { error: updateError } = await admin
        .from('consultant_profiles')
        .update({ referral_code: referralCode })
        .eq('id', profile.id)

      if (updateError !== null) {
        authedLog.error('Failed to persist referral code', { error: updateError.message })
        return jsonError(req, 'Internal server error', 500)
      }

      authedLog.info('Referral code generated and persisted', {
        consultant_id: profile.id,
        referral_code: referralCode,
      })
    }

    // ── Step 8: Fetch order count attributed to this consultant ──────────────
    // Count of all paid/fulfilled orders where channel = 'consultant_assisted'
    // and consultant_id = this profile's id. Excludes cancelled/refunded orders.

    const { count: referredOrderCount, error: countError } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('consultant_id', profile.id)
      .in('status', ['paid', 'fulfilling', 'fulfilled', 'partially_returned'])

    if (countError !== null) {
      // Non-fatal: log and default to null rather than failing the whole response.
      authedLog.warn('Order count query failed', { error: countError.message })
    }

    // ── Step 9: Build referral URL ───────────────────────────────────────────

    const storefrontUrl = (Deno.env.get('STOREFRONT_URL') ?? '').replace(/\/$/, '')
    const referralUrl   = `${storefrontUrl}${REFERRAL_PATH}${referralCode}`
    const shareText     = `Shop licensed Game Time Gift gear through my link: ${referralUrl}`

    authedLog.info('Referral link retrieved', {
      consultant_id: profile.id,
      referral_code: referralCode,
    })

    return jsonResponse(req, {
      consultant_id:              profile.id,
      display_name:               profile.display_name,
      referral_code:              referralCode,
      referral_url:               referralUrl,
      share_text:                 shareText,
      lifetime_gross_sales_cents: profile.lifetime_gross_sales_cents,
      lifetime_commissions_cents: profile.lifetime_commissions_cents,
      total_referred_orders:      referredOrderCount ?? null,
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
