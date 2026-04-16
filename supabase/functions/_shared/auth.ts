/**
 * Authorization helpers for GTG Edge Functions.
 *
 * ─── The secure access pattern ───────────────────────────────────────────────
 *
 * Service-role (admin) clients bypass ALL Row Level Security. The pattern here
 * enforces a hard ordering: authenticate → authorize → escalate to admin.
 *
 * The key mechanism is the AuthorizedUser type. It can only be obtained by
 * calling verifyRole(), which validates both the JWT and the role. Passing
 * an AuthorizedUser to functions that use the admin client documents — at the
 * call site — that authorization has already happened.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // 1. Authenticate (getUser validates the JWT server-side)
 *   const { data: { user }, error } = await userClient.auth.getUser()
 *   if (error || !user) return unauthorized(req)
 *
 *   // 2. Authorize (verifyRole() returns a discriminated union)
 *   const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
 *   if (denied) return denied
 *
 *   // 3. Safe to escalate — authorized.id is available for audit attribution
 *   const admin = createAdminClient()
 *   log.withUser(authorized.id).info('Admin action', { role: authorized.role })
 *
 * ─── Role sets ────────────────────────────────────────────────────────────────
 *
 *   ADMIN_ROLES       — super_admin, admin
 *   REPORTING_ROLES   — super_admin, admin, licensor_auditor
 *   ALL_ROLES         — any authenticated role (no restriction beyond login)
 */

import { forbidden } from './response.ts'

// ─── Roles ────────────────────────────────────────────────────────────────────

/**
 * All valid role values for the GTG system.
 *
 * Mirrors the `role` field in auth.users.app_metadata, which is set server-side
 * by the admin app (never by the user). The JWT embeds app_metadata, so role
 * values here are trustworthy — they cannot be forged by the client.
 *
 * Matches the RLS helper used in SQL policies:
 *   auth.jwt() -> 'app_metadata' ->> 'role'
 */
export type AppRole =
  | 'super_admin'
  | 'admin'
  | 'licensor_auditor'
  | 'consultant'
  | 'customer'

/** All valid role values as a set for O(1) membership checks. */
const VALID_ROLES = new Set<string>([
  'super_admin',
  'admin',
  'licensor_auditor',
  'consultant',
  'customer',
])

// ─── Named Role Sets ──────────────────────────────────────────────────────────
// Use these in verifyRole() rather than inline arrays. They are the single
// source of truth for which roles can perform which class of operation.

/** Full admin access — platform management, all data. */
export const ADMIN_ROLES: readonly AppRole[] = ['super_admin', 'admin']

/** Read access to royalty and sales data for external license-holder audits. */
export const REPORTING_ROLES: readonly AppRole[] = ['super_admin', 'admin', 'licensor_auditor']

/** Any authenticated user regardless of role. Use for self-service operations. */
export const ALL_ROLES: readonly AppRole[] = [
  'super_admin',
  'admin',
  'licensor_auditor',
  'consultant',
  'customer',
]

// ─── AuthorizedUser ───────────────────────────────────────────────────────────

/**
 * Proof of successful authentication and role authorization.
 *
 * This type can only be obtained by calling verifyRole(). It is passed to
 * admin-client code paths to document — structurally, not just by convention —
 * that auth has already been verified for this request.
 *
 * Use authorized.id for audit attribution when recording who triggered an
 * admin action (e.g. when writing to created_by / reviewed_by columns via
 * the service-role client).
 */
export interface AuthorizedUser {
  /** Supabase auth.users.id — use for audit column attribution. */
  readonly id: string
  /** Verified role from app_metadata. */
  readonly role: AppRole
}

// ─── verifyRole ───────────────────────────────────────────────────────────────

/**
 * Verify that the authenticated user holds one of the required roles.
 *
 * Returns a discriminated union so the caller is forced to handle the
 * unauthorized branch before reaching any code that uses the admin client.
 *
 * @param user    The user object returned by supabase.auth.getUser().
 * @param allowed The role set to check against (use a named constant above).
 * @param req     The incoming request, needed to build the CORS-aware response.
 *
 * @returns
 *   { authorized: AuthorizedUser; denied: null }  — role check passed
 *   { authorized: null; denied: Response }        — role check failed; return `denied` immediately
 *
 * @example
 *   const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
 *   if (denied) return denied
 *   // authorized.id and authorized.role are now available
 */
export function verifyRole(
  user: { id: string; app_metadata?: Record<string, unknown> },
  allowed: readonly AppRole[] | ReadonlySet<AppRole>,
  req: Request,
): { authorized: AuthorizedUser; denied: null } | { authorized: null; denied: Response } {
  const role = extractRole(user)

  const isAllowedRole =
    role !== null &&
    (Array.isArray(allowed) ? allowed.includes(role) : allowed.has(role))

  if (!isAllowedRole) {
    return { authorized: null, denied: forbidden(req) }
  }

  return { authorized: { id: user.id, role }, denied: null }
}

// ─── extractRole ─────────────────────────────────────────────────────────────

/**
 * Safely extract the AppRole from a user's app_metadata.
 *
 * Returns null if the role field is absent, not a string, or not a recognised
 * AppRole value. Never throws — callers handle the null case explicitly.
 *
 * @example
 *   const role = extractRole(user)   // AppRole | null
 */
export function extractRole(
  user: { app_metadata?: Record<string, unknown> },
): AppRole | null {
  const raw = user.app_metadata?.['role']
  if (typeof raw !== 'string') return null
  if (!VALID_ROLES.has(raw)) return null
  return raw as AppRole
}
