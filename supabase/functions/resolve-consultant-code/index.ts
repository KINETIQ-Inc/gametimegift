/**
 * GTG Edge Function — resolve-consultant-code
 *
 * Public storefront helper that validates a referral code and resolves it to
 * a consultant profile id for order attribution.
 *
 * Authorization:
 *   Public. JWT verification disabled in config so unauthenticated storefront
 *   visitors can attribute their order before checkout.
 *
 * Response:
 *   200 { data: { consultant_id, display_name, referral_code } }
 *   404 { error: "Consultant referral code not found." }
 */

import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse } from '../_shared/response.ts'
import { createAdminClient } from '../_shared/supabase.ts'

const REFERRAL_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,19}$/

interface RequestBody {
  referral_code?: unknown
}

interface ConsultantRow {
  id: string
  display_name: string
  referral_code: string
  status: string
}

Deno.serve(async (req: Request): Promise<Response> => {
  const log = createLogger('resolve-consultant-code', req)
  log.info('Handler invoked', { method: req.method })

  const preflight = handleCors(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return jsonError(req, 'Method not allowed', 405)
  }

  try {
    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    const referralCode = typeof body.referral_code === 'string'
      ? body.referral_code.trim().toUpperCase()
      : ''

    if (!referralCode) {
      return jsonError(req, 'referral_code is required.', 400)
    }

    if (!REFERRAL_CODE_RE.test(referralCode)) {
      return jsonError(req, 'referral_code format is invalid.', 400)
    }

    const admin = createAdminClient()
    const { data, error } = await admin
      .from('consultant_profiles')
      .select('id, display_name, referral_code, status')
      .eq('referral_code', referralCode)
      .eq('status', 'active')
      .maybeSingle()

    if (error !== null) {
      log.error('Consultant lookup failed', { error: error.message })
      return jsonError(req, 'Internal server error', 500)
    }

    if (!data) {
      return jsonError(req, 'Consultant referral code not found.', 404)
    }

    const consultant = data as ConsultantRow

    return jsonResponse(req, {
      consultant_id: consultant.id,
      display_name: consultant.display_name,
      referral_code: consultant.referral_code,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
