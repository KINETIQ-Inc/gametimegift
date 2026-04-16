/**
 * GTG Edge Function — set-commission-tier-rates
 *
 * Admin commission tier rate management (4A-4).
 * Updates the active rate for one or more named commission tiers (standard,
 * senior, elite) in a single atomic operation. Rates are append-only — the
 * current active row is deactivated and a new row is inserted, preserving the
 * full historical rate record.
 *
 * ─── Rate change workflow ─────────────────────────────────────────────────────
 *
 * For each tier submitted:
 *   1. Current active row → is_active = false (deactivated)
 *   2. New row inserted   → is_active = true  (becomes active)
 *
 * Both steps are atomic (single DB transaction via set_commission_tier_rates).
 * If either fails, both are rolled back — the tier is never left without a rate.
 *
 * ─── Partial updates ──────────────────────────────────────────────────────────
 *
 * You may update 1, 2, or all 3 tiers in a single call. Tiers absent from
 * the request are unchanged. The response always includes all active rates
 * (changed and unchanged) for a complete picture.
 *
 * ─── Custom tier ──────────────────────────────────────────────────────────────
 *
 * The 'custom' tier is excluded — its rate lives per-consultant on
 * consultant_profiles.custom_commission_rate, not in commission_tier_config.
 * Submitting tier = 'custom' returns 400.
 *
 * ─── Notes requirement ────────────────────────────────────────────────────────
 *
 * notes is required for every tier change. The audit trail depends on every
 * rate row documenting the reason it was set. Acceptable examples:
 *   "Q2 2026 rate adjustment — board approval 2026-03-01"
 *   "Standard tier corrected to 11% per amended license agreement"
 *
 * ─── Duplicate tiers in one request ──────────────────────────────────────────
 *
 * Submitting the same tier twice in one request is rejected. The result would
 * be undefined (two deactivations, two insertions — only the last insert would
 * survive the partial unique index). Submit one entry per tier.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 * Commission rates directly affect every consultant payout — admin authority required.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/set-commission-tier-rates
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *   {
 *     "tiers": [
 *       {
 *         "tier":  "standard",
 *         "rate":  0.11,
 *         "notes": "Q2 2026 rate adjustment — board approval 2026-03-01."
 *       },
 *       {
 *         "tier":  "senior",
 *         "rate":  0.16,
 *         "notes": "Q2 2026 rate adjustment — board approval 2026-03-01."
 *       }
 *     ]
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "changes": [
 *         { "tier": "standard", "old_rate": 0.10, "new_rate": 0.11 },
 *         { "tier": "senior",   "old_rate": 0.15, "new_rate": 0.16 }
 *       ],
 *       "active_rates": [
 *         {
 *           "id":         "<uuid>",
 *           "tier":       "elite",
 *           "rate":       0.20,
 *           "notes":      "Initial default rate: 20.00%. Review before launch.",
 *           "created_at": "2026-03-05T...",
 *           "created_by": null
 *         },
 *         {
 *           "id":         "<uuid>",
 *           "tier":       "senior",
 *           "rate":       0.16,
 *           "notes":      "Q2 2026 rate adjustment — board approval 2026-03-01.",
 *           "created_at": "2026-03-06T...",
 *           "created_by": "<uuid>"
 *         },
 *         {
 *           "id":         "<uuid>",
 *           "tier":       "standard",
 *           "rate":       0.11,
 *           "notes":      "Q2 2026 rate adjustment — board approval 2026-03-01.",
 *           "created_at": "2026-03-06T...",
 *           "created_by": "<uuid>"
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TIERS = new Set(['standard', 'senior', 'elite'])

const MAX_TIERS_PER_REQUEST = 3   // one per named tier; duplicates caught separately

// ─── Types ────────────────────────────────────────────────────────────────────

interface TierUpdate {
  tier:  string
  rate:  number
  notes: string
}

interface RequestBody {
  tiers: TierUpdate[]
}

interface TierChange {
  tier:     string
  old_rate: number | null
  new_rate: number
}

interface ActiveRate {
  id:         string
  tier:       string
  rate:       number
  notes:      string | null
  created_at: string
  created_by: string | null
}

interface SetRatesResult {
  changes:      TierChange[]
  active_rates: ActiveRate[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('set-commission-tier-rates', req)
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

    if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
      return jsonError(
        req,
        'tiers must be a non-empty array of { tier, rate, notes } objects.',
        400,
      )
    }

    if (body.tiers.length > MAX_TIERS_PER_REQUEST) {
      return jsonError(
        req,
        `tiers may contain at most ${MAX_TIERS_PER_REQUEST} entries (one per named tier).`,
        400,
      )
    }

    // Validate each entry and detect duplicates
    const seenTiers = new Set<string>()

    for (const entry of body.tiers) {
      if (!entry.tier || typeof entry.tier !== 'string') {
        return jsonError(req, "Each tier entry must include a 'tier' field.", 400)
      }

      if (entry.tier === 'custom') {
        return jsonError(
          req,
          "The 'custom' tier rate is assigned per-consultant on their profile, " +
          "not via commission_tier_config. Remove 'custom' from the tiers array.",
          400,
        )
      }

      if (!VALID_TIERS.has(entry.tier)) {
        return jsonError(
          req,
          `Invalid tier '${entry.tier}'. Must be one of: standard, senior, elite.`,
          400,
        )
      }

      if (seenTiers.has(entry.tier)) {
        return jsonError(
          req,
          `Duplicate tier '${entry.tier}' in request. Submit at most one entry per tier.`,
          400,
        )
      }
      seenTiers.add(entry.tier)

      if (typeof entry.rate !== 'number' || !isFinite(entry.rate)) {
        return jsonError(
          req,
          `rate for tier '${entry.tier}' must be a finite number (e.g. 0.15 for 15%).`,
          400,
        )
      }

      if (entry.rate <= 0 || entry.rate > 1) {
        return jsonError(
          req,
          `rate for tier '${entry.tier}' must be > 0 and <= 1. Got ${entry.rate}.`,
          400,
        )
      }

      if (!entry.notes || typeof entry.notes !== 'string' || entry.notes.trim().length === 0) {
        return jsonError(
          req,
          `notes are required for tier '${entry.tier}'. ` +
          'Document the reason for this rate change (e.g. "Q2 2026 board approval").',
          400,
        )
      }
    }

    // ── Step 6: Apply tier rate changes atomically ──────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Applying tier rate changes', {
      tiers: body.tiers.map((t) => ({ tier: t.tier, rate: t.rate })),
    })

    const { data: result, error: rpcError } = await admin.rpc(
      'set_commission_tier_rates',
      {
        p_updates: body.tiers,
        p_set_by:  authorized.id,
      },
    )

    if (rpcError !== null) {
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('set_commission_tier_rates failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const outcome = result as SetRatesResult

    authedLog.info('Tier rates updated', {
      changes: outcome.changes.map((c) => ({
        tier:     c.tier,
        old_rate: c.old_rate,
        new_rate: c.new_rate,
      })),
    })

    return jsonResponse(req, outcome)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
