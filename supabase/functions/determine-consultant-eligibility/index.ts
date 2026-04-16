/**
 * GTG Edge Function — determine-consultant-eligibility
 *
 * Checks whether a consultant is eligible to earn a commission on a new sale
 * and resolves their effective commission rate.
 *
 * Called by the order processing engine before creating commission entries.
 * Also callable by the consultant app to show a consultant their own status.
 *
 * ─── Eligibility rules ────────────────────────────────────────────────────────
 *
 * A consultant is ELIGIBLE when ALL of the following are true:
 *   1. Their account status is 'active'.
 *      (pending_approval, suspended, terminated → ineligible)
 *   2. No active lock records exist for this consultant
 *      (lock_records where scope='consultant', target_id=consultant_id, is_active=true).
 *      An active lock means a fraud investigation has suspended their account at
 *      the enforcement layer, regardless of the status field.
 *
 * A consultant is ELIGIBLE but commission will be HELD (not immediately approved)
 * when tax_onboarding_complete = false. The commission entry is created with
 * status='held' rather than 'earned'. This is not an ineligibility condition —
 * it is reflected in the response's commission_initial_status field.
 *
 * ─── Effective rate resolution ────────────────────────────────────────────────
 *
 * commission_tier = 'custom'  → rate = consultant_profiles.custom_commission_rate
 * commission_tier = other     → rate = commission_tier_config.rate where
 *                               tier = commission_tier and is_active = true
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES — may check any consultant.
 * consultant  — may check only their own profile (ownership enforced via
 *               consultant_profiles.auth_user_id = caller's auth.uid()).
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/determine-consultant-eligibility
 *   Authorization: Bearer <jwt>
 *   Content-Type: application/json
 *   { "consultant_id": "uuid" }
 *
 * ─── Response (eligible) ─────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": true,
 *       "consultant_id": "...",
 *       "display_name": "Jane Smith",
 *       "status": "active",
 *       "commission_tier": "senior",
 *       "effective_rate": 0.15,
 *       "commission_initial_status": "earned",
 *       "tax_onboarding_complete": true,
 *       "ineligibility_reasons": [],
 *       "active_locks": []
 *     }
 *   }
 *
 * ─── Response (ineligible) ───────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "eligible": false,
 *       "consultant_id": "...",
 *       "display_name": "John Doe",
 *       "status": "suspended",
 *       "commission_tier": "standard",
 *       "effective_rate": null,
 *       "commission_initial_status": null,
 *       "tax_onboarding_complete": false,
 *       "ineligibility_reasons": [
 *         "Consultant status is 'suspended'. Only 'active' consultants may earn commissions.",
 *         "1 active enforcement lock(s) on this consultant account."
 *       ],
 *       "active_locks": [
 *         {
 *           "lock_id": "...",
 *           "lock_reason": "Velocity anomaly investigation",
 *           "lock_authority": "gtg_admin",
 *           "locked_at": "2026-03-05T14:00:00Z"
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing / invalid consultant_id)
 *   401  Unauthenticated
 *   403  Forbidden (consultant trying to check another consultant's eligibility)
 *   404  Consultant not found
 *   500  Internal server error (e.g. no active tier config for this tier)
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve determine-consultant-eligibility \
 *     --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/determine-consultant-eligibility' \
 *     --header 'Authorization: Bearer <jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{"consultant_id": "<uuid>"}'
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import type { AppRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Roles that may call this function. Consultants may check their own profile only. */
const ELIGIBLE_ROLES: readonly AppRole[] = ['super_admin', 'admin', 'consultant']

/** The only status from which a consultant earns new commissions. */
const EARNING_STATUS = 'active'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestBody {
  consultant_id: string
}

interface ActiveLock {
  lock_id: string
  lock_reason: string
  lock_authority: string
  locked_at: string
}

interface ResponsePayload {
  eligible: boolean
  consultant_id: string
  display_name: string
  status: string
  commission_tier: string
  /**
   * Resolved decimal commission rate (e.g. 0.15).
   * null when the consultant is ineligible or the rate cannot be determined.
   */
  effective_rate: number | null
  /**
   * Status to use when creating the commission entry for a sale.
   * 'earned'  — standard flow; consultant is active and tax-onboarded.
   * 'held'    — consultant is eligible but tax_onboarding_complete = false;
   *             commission is created but withheld from payout batches.
   * null      — consultant is ineligible; no commission entry should be created.
   */
  commission_initial_status: 'earned' | 'held' | null
  /** Whether the consultant has completed W-9 / tax onboarding. */
  tax_onboarding_complete: boolean
  /** Human-readable reasons for ineligibility. Empty array when eligible. */
  ineligibility_reasons: string[]
  /** Active enforcement locks on this consultant account. */
  active_locks: ActiveLock[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('determine-consultant-eligibility', req)
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

    const { authorized, denied } = verifyRole(user, ELIGIBLE_ROLES, req)
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

    if (!body.consultant_id || typeof body.consultant_id !== 'string') {
      return jsonError(req, 'consultant_id is required', 400)
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidPattern.test(body.consultant_id)) {
      return jsonError(req, 'consultant_id must be a valid UUID v4', 400)
    }

    // ── Step 6: Fetch consultant and active locks (parallel) ──────────────────
    // Both queries are independent of each other — run in parallel.
    // The tier config query is conditional on the consultant's tier, so it
    // runs after the consultant fetch.

    const admin = createAdminClient()

    const [consultantResult, locksResult] = await Promise.all([
      admin
        .from('consultant_profiles')
        .select(`
          id,
          auth_user_id,
          status,
          display_name,
          commission_tier,
          custom_commission_rate,
          tax_onboarding_complete
        `)
        .eq('id', body.consultant_id)
        .single(),

      admin
        .from('lock_records')
        .select('id, lock_reason, lock_authority, locked_at')
        .eq('scope', 'consultant')
        .eq('target_id', body.consultant_id)   // target_id is text on lock_records
        .eq('is_active', true),
    ])

    // ── Handle not found ──────────────────────────────────────────────────────
    if (consultantResult.error !== null) {
      if (consultantResult.error.code === 'PGRST116') {
        authedLog.warn('Consultant not found', { consultant_id: body.consultant_id })
        return jsonError(req, `Consultant not found: ${body.consultant_id}`, 404)
      }
      authedLog.error('DB error fetching consultant', { code: consultantResult.error.code })
      return jsonError(req, 'Internal server error', 500)
    }

    const consultant = consultantResult.data

    // ── Ownership check for consultant role ───────────────────────────────────
    // A consultant JWT may only inspect their own eligibility.
    // Verified after fetch so the error message is accurate (404 if truly not
    // found; 403 if found but not theirs).

    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(authorized.role)
    if (!isAdmin && consultant.auth_user_id !== authorized.id) {
      authedLog.warn('Ownership check failed', {
        consultant_id: body.consultant_id,
        role: authorized.role,
      })
      return jsonError(req, 'You are not authorized to check this consultant\'s eligibility', 403)
    }

    const activeLocks: ActiveLock[] = (locksResult.data ?? []).map((row) => ({
      lock_id:        row.id,
      lock_reason:    row.lock_reason,
      lock_authority: row.lock_authority,
      locked_at:      row.locked_at,
    }))

    authedLog.info('Consultant fetched', {
      consultant_id: consultant.id,
      status: consultant.status,
      tier: consultant.commission_tier,
      active_lock_count: activeLocks.length,
    })

    // ── Step 7: Evaluate eligibility ──────────────────────────────────────────

    const ineligibilityReasons: string[] = []

    // Check 1: account status must be 'active'.
    if (consultant.status !== EARNING_STATUS) {
      ineligibilityReasons.push(
        `Consultant status is '${consultant.status}'. ` +
        `Only 'active' consultants may earn commissions.`,
      )
    }

    // Check 2: no active enforcement locks.
    if (activeLocks.length > 0) {
      ineligibilityReasons.push(
        `${activeLocks.length} active enforcement lock(s) on this consultant account. ` +
        `Locks must be released before new commissions can be earned.`,
      )
    }

    const eligible = ineligibilityReasons.length === 0

    // ── Step 8: Resolve effective commission rate ─────────────────────────────
    // Only meaningful (and only attempted) when the consultant is eligible.
    // An ineligible consultant has no rate to resolve — the rate is irrelevant
    // to the caller until eligibility is restored.

    let effectiveRate: number | null = null

    if (eligible) {
      if (consultant.commission_tier === 'custom') {
        // Custom rate lives on the profile. The DB constraint ensures this is
        // non-null when tier = 'custom', but we guard defensively.
        if (consultant.custom_commission_rate === null) {
          authedLog.error('Custom tier consultant has no custom_commission_rate', {
            consultant_id: consultant.id,
          })
          return jsonError(
            req,
            `Consultant ${consultant.id} has commission_tier='custom' but ` +
            `custom_commission_rate is null. Admin must set a rate before this ` +
            `consultant can process sales.`,
            500,
          )
        }
        effectiveRate = Number(consultant.custom_commission_rate)
      } else {
        // Named tier: look up the active rate from commission_tier_config.
        const { data: tierConfig, error: tierError } = await admin
          .from('commission_tier_config')
          .select('rate')
          .eq('tier', consultant.commission_tier)
          .eq('is_active', true)
          .single()

        if (tierError !== null || tierConfig === null) {
          authedLog.error('No active commission tier config found', {
            tier: consultant.commission_tier,
            code: tierError?.code,
          })
          return jsonError(
            req,
            `No active commission rate configuration found for tier '${consultant.commission_tier}'. ` +
            `An admin must insert an active row in commission_tier_config for this tier.`,
            500,
          )
        }

        effectiveRate = Number(tierConfig.rate)
      }
    }

    // ── Step 9: Determine commission_initial_status ───────────────────────────
    // When eligible: 'held' if tax onboarding is not complete; 'earned' otherwise.
    // When ineligible: null — no commission entry should be created at all.

    const commissionInitialStatus: 'earned' | 'held' | null = eligible
      ? (consultant.tax_onboarding_complete ? 'earned' : 'held')
      : null

    // ── Step 10: Build and return response ────────────────────────────────────

    authedLog.info('Eligibility determined', {
      consultant_id: consultant.id,
      eligible,
      effective_rate: effectiveRate,
      commission_initial_status: commissionInitialStatus,
    })

    const payload: ResponsePayload = {
      eligible,
      consultant_id:             consultant.id,
      display_name:              consultant.display_name,
      status:                    consultant.status,
      commission_tier:           consultant.commission_tier,
      effective_rate:            effectiveRate,
      commission_initial_status: commissionInitialStatus,
      tax_onboarding_complete:   consultant.tax_onboarding_complete,
      ineligibility_reasons:     ineligibilityReasons,
      active_locks:              activeLocks,
    }

    return jsonResponse(req, payload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
