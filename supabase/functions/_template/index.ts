/**
 * GTG Edge Function — template
 *
 * Copy this directory to supabase/functions/<function-name>/index.ts when
 * creating a new function. Then:
 *
 *   1. Rename the function (replace REPLACE_ME_FUNCTION_NAME in the
 *      Deno.serve() call and the createLogger() call).
 *   2. Define the expected request body type (see RequestBody).
 *   3. Define the response payload type (see ResponsePayload).
 *   4. Set the required role set in verifyRole() — or swap to ALL_ROLES for
 *      functions callable by any authenticated user.
 *   5. Replace the placeholder business logic with real implementation.
 *   6. Add a [functions.<name>] entry to supabase/config.toml if the function
 *      needs non-default settings (verify_jwt, import_map, etc.).
 *
 * Directories prefixed with _ (this directory, _shared/) are never deployed
 * by `supabase functions deploy --all`. Rename to a non-_ name to deploy.
 *
 * ─── Local testing ───────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve <function-name> --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/<function-name>' \
 *     --header 'Authorization: Bearer <anon-or-service-role-key>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{"example": "value"}'
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of the JSON body this function expects. */
interface RequestBody {
  // TODO: define fields
  example: string
}

/** Shape of the JSON data this function returns on success. */
interface ResponsePayload {
  // TODO: define fields
  result: string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────
  // Create first — before any early return — so preflights and auth failures
  // are traced.

  const log = createLogger('REPLACE_ME_FUNCTION_NAME', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ──────────────────────────────────────────────────
    // getUser() validates the JWT server-side. A missing, expired, or forged
    // token returns an error — never a user. Do not skip this call.

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ─────────────────────────────────────────────────────
    // verifyRole() returns a discriminated union. The `denied` branch must be
    // handled before `authorized` is accessible — this is the secure access
    // pattern: you cannot reach admin-client code without passing the role check.
    //
    // Swap ADMIN_ROLES for REPORTING_ROLES or ALL_ROLES as appropriate.

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    // authorized.id and authorized.role are now available.
    // Bind userId to all subsequent log lines.
    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ───────────────────────────────

    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.example || typeof body.example !== 'string') {
      return jsonError(req, 'Missing required field: example', 422)
    }

    // ── Step 6: Business logic ────────────────────────────────────────────────
    // The admin client bypasses RLS. Only use it here — after the role check
    // has confirmed the caller is authorized.
    //
    // Pass authorized.id to any created_by / reviewed_by column so the audit
    // trail records the real user, not the service role identity.

    const admin = createAdminClient()

    // Example:
    // const { data, error } = await admin
    //   .from('orders')
    //   .select('id, order_number, status')
    //   .eq('status', 'pending_payment')
    //
    // if (error) {
    //   authedLog.error('DB query failed', { table: 'orders', code: error.code })
    //   return jsonError(req, 'Internal server error', 500)
    // }
    //
    // authedLog.info('Query complete', { count: data.length })

    void admin // remove once real logic is added

    const result: ResponsePayload = {
      result: `Hello from REPLACE_ME_FUNCTION_NAME — received: ${body.example}`,
    }

    authedLog.info('Handler complete')
    return jsonResponse(req, result)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
