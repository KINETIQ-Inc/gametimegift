import type { ConsultantStatus, CommissionTier } from './consultant'

// ─── User Role ────────────────────────────────────────────────────────────────

/**
 * All authorization roles in the GTG system.
 *
 * Roles are additive — a user holds exactly one role, and that role
 * grants a specific capability set. There is no role inheritance;
 * each role's permissions are defined explicitly in the policy layer.
 *
 * Assignment rules:
 *   super_admin     — provisioned manually; never self-assigned
 *   admin           — assigned by super_admin
 *   licensor_auditor— assigned by super_admin; read-only, scoped to one licensor
 *   consultant      — assigned at account approval (ConsultantProfile.status → active)
 *   customer        — assigned at storefront registration
 *
 * Fraud lock authority:
 *   super_admin and admin may lock/unlock units and consultants.
 *   licensor_auditor may initiate a lock request; cannot apply directly.
 *   consultant and customer have no lock authority.
 */
export type UserRole =
  | 'super_admin'      // Full system access; manages admins and config
  | 'admin'            // Operational access; manages orders, inventory, consultants
  | 'licensor_auditor' // Read-only access scoped to one LicenseHolder for audit
  | 'consultant'       // Sells units; views own commission and order history
  | 'customer'         // Places orders; views own order history

// ─── Permission Key ───────────────────────────────────────────────────────────

/**
 * Discrete permission identifiers checked at the policy boundary.
 *
 * Permissions are not stored on the session — they are derived from the role
 * at the policy layer using a role-to-permission map. This type exists to
 * make the permission check call sites explicit and typo-proof.
 *
 * Naming convention: <resource>:<action>
 *   resource — the domain entity being accessed
 *   action   — what is being done to it
 */
export type PermissionKey =
  // Inventory
  | 'inventory:read'
  | 'inventory:write'
  | 'inventory:lock'       // Apply or release a fraud lock on a unit
  // Orders
  | 'orders:read_any'      // View any customer's orders
  | 'orders:read_own'      // View own orders only
  | 'orders:write'         // Create or modify orders
  | 'orders:refund'        // Issue refunds
  // Consultants
  | 'consultants:read_any'
  | 'consultants:read_own' // Consultant viewing their own profile
  | 'consultants:write'    // Create or modify consultant profiles
  | 'consultants:suspend'  // Change consultant status to suspended/terminated
  // Commissions
  | 'commissions:read_any'
  | 'commissions:read_own'
  | 'commissions:approve'  // Approve commissions for payout
  // Royalties
  | 'royalties:read'
  | 'royalties:write'      // Create or submit royalty reports
  | 'royalties:read_scoped'// Licensor auditor: read royalties for their licensor only
  // Fraud
  | 'fraud:read'
  | 'fraud:write'          // Raise flags, add investigation notes
  | 'fraud:lock'           // Apply or release LockRecords
  | 'fraud:escalate'       // Escalate a flag to licensor
  // Admin
  | 'admin:read'           // View admin panel
  | 'admin:write'          // Modify system config, manage users
  | 'admin:super'          // Super-admin only: manage other admins, view audit log

// ─── Licensor Audit Scope ─────────────────────────────────────────────────────

/**
 * Scope restriction applied to a licensor_auditor session.
 * An auditor sees only royalty data for their assigned LicenseHolder.
 * Absent on all other roles — the field does not exist on their claims.
 */
export interface LicensorAuditScope {
  /** Foreign key → license_holders.id. */
  readonly licenseHolderId: string
  /** Denormalized — avoids a DB lookup on every request for display. */
  readonly licenseHolderCode: string
}

// ─── Session Claims ───────────────────────────────────────────────────────────

/**
 * Typed representation of the JWT claims embedded in a Supabase session.
 *
 * These claims are written to the `app_metadata` field of the Supabase Auth
 * user record. They are signed by Supabase and cannot be tampered with
 * client-side. The server and RLS policies read directly from the JWT.
 *
 * Standard JWT fields (sub, iat, exp, aud, iss) are NOT included here —
 * those are handled by the Supabase Auth SDK. This type covers only the
 * GTG-specific claims in the `app_metadata` namespace.
 *
 * Claim update policy:
 *   Role changes are applied server-side by an admin action.
 *   The session must be refreshed after a role change for claims to update.
 *   The client should call supabase.auth.refreshSession() after any
 *   admin-initiated role change affecting the current user.
 *
 * RLS policy contract:
 *   Supabase RLS policies access these claims via:
 *     (auth.jwt() -> 'app_metadata' ->> 'role')
 *   The claim names in this type must exactly match the keys set in
 *   app_metadata. Any rename here requires a matching RLS policy migration.
 */
export interface SessionClaims {
  /**
   * Supabase Auth user ID (UUID v4).
   * Mirrors auth.users.id — always present, never null.
   */
  readonly sub: string
  /** The user's assigned role. Single role per user — no role arrays. */
  readonly role: UserRole
  /**
   * The user's display name at time of token issuance.
   * Used for audit log attribution. May be stale if the user updates
   * their name — refresh the session to get the current value.
   */
  readonly displayName: string
  /** The user's email at time of token issuance. */
  readonly email: string
  /**
   * For role 'consultant': the ConsultantProfile.id.
   * Required for all consultant-scoped API calls and RLS policies.
   * Null for all other roles.
   */
  readonly consultantProfileId: string | null
  /**
   * For role 'consultant': current account status.
   * Checked at the API boundary — suspended consultants cannot place
   * or facilitate orders even if their session is still valid.
   * Null for all other roles.
   */
  readonly consultantStatus: ConsultantStatus | null
  /**
   * For role 'consultant': current commission tier.
   * Embedded in the token to avoid a profile lookup on every sale.
   * Null for all other roles.
   */
  readonly consultantTier: CommissionTier | null
  /**
   * For role 'licensor_auditor': the scope of their read access.
   * Null for all other roles.
   */
  readonly licensorScope: LicensorAuditScope | null
  /**
   * ISO 8601 — when these claims were last updated by an admin action.
   * Distinct from the JWT iat — claims may have been re-issued multiple
   * times. Used to detect stale sessions after a role change.
   */
  readonly claimsIssuedAt: string
}

// ─── Role Permission Map ──────────────────────────────────────────────────────

/**
 * Compile-time mapping of every UserRole to its granted PermissionKey set.
 *
 * This is the single source of truth for authorization.
 * Policy functions in packages/domain import this map and check permissions
 * against it. No permission check should hardcode a role name —
 * always derive from this map.
 *
 * `as const` ensures the values are readonly string literal tuples,
 * enabling exhaustive type checks in the policy layer.
 */
export const ROLE_PERMISSIONS = {
  super_admin: [
    'inventory:read', 'inventory:write', 'inventory:lock',
    'orders:read_any', 'orders:write', 'orders:refund',
    'consultants:read_any', 'consultants:write', 'consultants:suspend',
    'commissions:read_any', 'commissions:approve',
    'royalties:read', 'royalties:write',
    'fraud:read', 'fraud:write', 'fraud:lock', 'fraud:escalate',
    'admin:read', 'admin:write', 'admin:super',
  ],
  admin: [
    'inventory:read', 'inventory:write', 'inventory:lock',
    'orders:read_any', 'orders:write', 'orders:refund',
    'consultants:read_any', 'consultants:write', 'consultants:suspend',
    'commissions:read_any', 'commissions:approve',
    'royalties:read', 'royalties:write',
    'fraud:read', 'fraud:write', 'fraud:lock', 'fraud:escalate',
    'admin:read', 'admin:write',
  ],
  licensor_auditor: [
    'royalties:read_scoped',
    'fraud:read',
  ],
  consultant: [
    'inventory:read',
    'orders:read_own', 'orders:write',
    'consultants:read_own',
    'commissions:read_own',
  ],
  customer: [
    'orders:read_own', 'orders:write',
  ],
} as const satisfies Record<UserRole, readonly PermissionKey[]>
