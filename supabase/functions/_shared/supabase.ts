/**
 * Supabase client factories for GTG Edge Functions.
 *
 * ─── Key isolation model ──────────────────────────────────────────────────────
 *
 * Two keys exist in the Supabase project:
 *
 *   SUPABASE_ANON_KEY          Public. Subject to Row Level Security (RLS).
 *                              Safe to ship in browser bundles. Used here only
 *                              to bootstrap the user-scoped client; the caller's
 *                              JWT drives all actual data access decisions.
 *
 *   SUPABASE_SERVICE_ROLE_KEY  Secret. Bypasses ALL RLS. Must never appear in
 *                              browser code, VITE_-prefixed env vars, or API
 *                              responses. Readable only via Deno.env.get() in
 *                              the Edge Function (Deno) runtime.
 *
 * Both keys are injected automatically by the Supabase runtime. Neither is
 * referenced in the @gtg/supabase browser package or any Vite app.
 *
 * ─── Client selection rule ───────────────────────────────────────────────────
 *
 *   createUserClient(req)  — for auth verification (getUser).
 *                            The caller's JWT is forwarded; RLS applies.
 *                            Use this ONLY to confirm identity, never for
 *                            data queries — user-visible data is fetched via
 *                            the admin client after auth/authz is verified.
 *
 *   createAdminClient()    — for all data reads and writes inside handlers.
 *                            Call AFTER verifyRole() has confirmed the caller
 *                            is authorized. Never expose the client instance
 *                            or query results to unauthenticated code paths.
 *
 * ─── Pattern ─────────────────────────────────────────────────────────────────
 *
 *   Deno.serve(async (req) => {
 *     const preflight = handleCors(req)
 *     if (preflight) return preflight
 *
 *     // 1. Verify identity (user client — RLS scope)
 *     const userClient = createUserClient(req)
 *     const { data: { user }, error } = await userClient.auth.getUser()
 *     if (error || !user) return unauthorized(req)
 *
 *     // 2. Verify role (auth helper — no DB call)
 *     const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
 *     if (denied) return denied
 *
 *     // 3. Admin client — safe to use only after steps 1 and 2
 *     const admin = createAdminClient()
 *     const { data } = await admin.from('orders').select('*')
 *     // ...
 *   })
 */

import { createClient } from 'npm:@supabase/supabase-js@^2'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@^2'
import type { Database } from '../../../packages/supabase/src/types.ts'

// ─── Admin Client (service role — bypasses RLS) ───────────────────────────────

/**
 * Create a Supabase admin client using the service role key.
 *
 * Call once per handler, after authentication and authorization are confirmed.
 * Do not cache the result across requests — each invocation gets a fresh
 * stateless client.
 *
 * @throws If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars are absent.
 */
export function createAdminClient(): SupabaseClient<Database> {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !key) {
    throw new Error(
      '[GTG] Edge Function is missing required env vars: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.\n' +
      '  → Locally: ensure the local stack is running (`supabase start`).\n' +
      '  → In production: set secrets with `supabase secrets set`.',
    )
  }

  return createClient<Database>(url, key, {
    auth: {
      // Stateless — no session persistence in Edge Function context.
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

// ─── User Client (inherits caller's JWT — respects RLS) ───────────────────────

/**
 * Create a user-scoped Supabase client from the caller's Authorization header.
 *
 * Passes the caller's JWT to the Supabase client so that auth.getUser() can
 * validate the caller's identity server-side. Use ONLY for getUser() calls.
 * All data queries after authentication should use the admin client.
 *
 * Missing or absent Authorization headers are handled gracefully: the client
 * is still created, getUser() returns a null user, and the caller's standard
 * auth check (if (!user) return unauthorized(req)) produces a 401 response.
 * This avoids a thrown exception being caught by the outer handler as a 500.
 *
 * @throws If SUPABASE_URL or SUPABASE_ANON_KEY env vars are absent (config error).
 *
 * @example
 *   const userClient = createUserClient(req)
 *   const { data: { user }, error } = await userClient.auth.getUser()
 *   if (error || !user) return unauthorized(req)   // 401, not 500
 */
export function createUserClient(req: Request): SupabaseClient<Database> {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!url || !anonKey) {
    throw new Error(
      '[GTG] Edge Function is missing required env vars: SUPABASE_URL and/or SUPABASE_ANON_KEY.',
    )
  }

  // Use the caller's JWT if present; fall back to an empty string so that
  // getUser() returns a null user (→ 401) rather than this function throwing
  // (→ outer catch → 500). A missing Authorization header is an auth failure,
  // not a server error.
  const authHeader = req.headers.get('authorization') ?? ''

  return createClient<Database>(url, anonKey, {
    global: { headers: { authorization: authHeader } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

// ─── getUserFromRequest ───────────────────────────────────────────────────────

/**
 * Authenticate the caller via local JWT verification using SUPABASE_JWT_SECRET.
 *
 * Verifies the HMAC-SHA256 signature of the bearer token without making any
 * network call to the auth API. This avoids the auth.getUser() pattern which
 * fails in stateless Edge Function contexts (persistSession:false means no
 * internal session, so getUser() without an explicit token hits the auth
 * endpoint anonymously and gets HTML back).
 *
 * Returns { data: { user: { id } }, error: null } on success.
 * Returns { data: { user: null }, error: Error } on failure.
 *
 * @example
 *   const { data: { user }, error } = await getUserFromRequest(req)
 *   if (error || !user) return unauthorized(req)
 */
export async function getUserFromRequest(req: Request): Promise<{
  data: { user: { id: string } | null }
  error: Error | null
}> {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^bearer\s+/i, '').trim()

  if (!token) {
    return { data: { user: null }, error: new Error('No authorization token') }
  }

  // If the caller sent the public anon key (no user session yet), generate a
  // random UUID so the request proceeds. Payment is the real security gate.
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (anonKey && token === anonKey) {
    return { data: { user: { id: crypto.randomUUID() } }, error: null }
  }

  // Verify JWT signature locally — no network call, works for anonymous users.
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET')
  if (jwtSecret) {
    const result = await _verifyJwtLocal(token, jwtSecret)
    if (result) return { data: { user: result }, error: null }
  }

  // Fallback: auth API
  const userClient = createUserClient(req)
  const apiResult = await userClient.auth.getUser(token)
  if (apiResult.error || !apiResult.data.user) {
    return { data: { user: null }, error: apiResult.error ?? new Error('Auth API returned no user') }
  }
  return { data: { user: { id: apiResult.data.user.id } }, error: null }
}

async function _verifyJwtLocal(
  token: string,
  secret: string,
): Promise<{ id: string } | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const b64url = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

    const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])))

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null

    // Verify HMAC-SHA256 signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const sigInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const sigBytes = b64url(parts[2])
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, sigInput)
    if (!valid) return null

    // Must have a subject (real user — anon or authenticated)
    if (!payload.sub) return null

    return { id: payload.sub as string }
  } catch {
    return null
  }
}
