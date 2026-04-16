/**
 * Admin Role Permission Definitions
 *
 * ─── ROLES ────────────────────────────────────────────────────────────────────
 *
 * GTG admin roles mirror the AppRole values enforced by the backend
 * (_shared/auth.ts). Role assignment lives in Supabase Auth app_metadata.role
 * and is enforced server-side via RLS + Edge Function role checks. This file
 * defines the UX surface — which controls render for each role — mirroring
 * the server-side enforcement.
 *
 * SUPER_ADMIN
 *   Full system authority. All operations permitted.
 *   Intended for: GTG founders / engineering leads.
 *   Backend role: 'super_admin'
 *
 * ADMIN
 *   Day-to-day operational authority. Can manage products, inventory,
 *   commissions, and fraud control. Cannot export financial CSVs or
 *   approve payouts / assign commission tiers.
 *   Intended for: GTG operations and fraud investigators.
 *   Backend role: 'admin'
 *
 * ─── PERMISSION MATRIX ────────────────────────────────────────────────────────
 *
 *                               SUPER_ADMIN   ADMIN
 * ── Product Management ────────────────────────────
 * Create / edit product             ✓            ✓
 * Deactivate product                ✓            ✓
 * Assign license body               ✓            ✓
 * Upload serialized units           ✓            ✓
 * Validate batch                    ✓            ✓
 *
 * ── Royalty & Financial ───────────────────────────
 * View royalty summary              ✓            ✓
 * Generate CLC / Army reports       ✓            ✓
 * Export royalty CSV                ✓            ✗
 * View commission summary           ✓            ✓
 * Approve payout batches            ✓            ✗
 *
 * ── Fraud Control ─────────────────────────────────
 * View fraud event queue            ✓            ✓
 * Lock unit                         ✓            ✓
 * Unlock unit                       ✓            ✓
 * Escalate fraud flag               ✓            ✓
 * Resolve fraud flag                ✓            ✓
 *
 * ── Consultant Management ─────────────────────────
 * Create / approve consultant       ✓            ✓
 * Suspend / terminate consultant    ✓            ✓
 * Assign commission tier            ✓            ✗
 */

// ─── Role Types ───────────────────────────────────────────────────────────────

/** Mirrors AppRole from supabase/functions/_shared/auth.ts (admin-accessible subset). */
export type AdminRole = 'super_admin' | 'admin'

// ─── Permission Keys ──────────────────────────────────────────────────────────

export type AdminPermission =
  // Product management
  | 'product:create'
  | 'product:edit'
  | 'product:deactivate'
  | 'product:assign_license'
  | 'product:upload_units'
  | 'product:validate_batch'
  // Royalty & financial
  | 'royalty:view_summary'
  | 'royalty:generate_report'
  | 'royalty:export_csv'
  | 'commission:view_summary'
  | 'commission:approve_payouts'
  | 'commission:assign_tier'
  // Fraud control
  | 'fraud:view_queue'
  | 'fraud:lock_unit'
  | 'fraud:unlock_unit'
  | 'fraud:escalate_flag'
  | 'fraud:resolve_flag'
  // Consultant management
  | 'consultant:create'
  | 'consultant:approve'
  | 'consultant:suspend_terminate'

// ─── Permission Sets ──────────────────────────────────────────────────────────

const SUPER_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  'product:create',
  'product:edit',
  'product:deactivate',
  'product:assign_license',
  'product:upload_units',
  'product:validate_batch',
  'royalty:view_summary',
  'royalty:generate_report',
  'royalty:export_csv',
  'commission:view_summary',
  'commission:approve_payouts',
  'commission:assign_tier',
  'fraud:view_queue',
  'fraud:lock_unit',
  'fraud:unlock_unit',
  'fraud:escalate_flag',
  'fraud:resolve_flag',
  'consultant:create',
  'consultant:approve',
  'consultant:suspend_terminate',
]

const ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  'product:create',
  'product:edit',
  'product:deactivate',
  'product:assign_license',
  'product:upload_units',
  'product:validate_batch',
  'royalty:view_summary',
  'royalty:generate_report',
  'commission:view_summary',
  'fraud:view_queue',
  'fraud:lock_unit',
  'fraud:unlock_unit',
  'fraud:escalate_flag',
  'fraud:resolve_flag',
  'consultant:create',
  'consultant:approve',
  'consultant:suspend_terminate',
]

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  super_admin: SUPER_ADMIN_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
}

// ─── Permission Check ─────────────────────────────────────────────────────────

/**
 * Returns true if the given role holds the given permission.
 *
 * Use at the component level to conditionally render controls.
 * Server-side enforcement is authoritative — this is display logic only.
 */
export function hasPermission(role: AdminRole, permission: AdminPermission): boolean {
  return (ROLE_PERMISSIONS[role] as AdminPermission[]).includes(permission)
}

/**
 * Returns all permissions held by a role.
 * Useful for rendering role summaries in the UI.
 */
export function getPermissionsForRole(role: AdminRole): readonly AdminPermission[] {
  return ROLE_PERMISSIONS[role]
}

// ─── Role Labels ──────────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
}

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  super_admin: 'Full system authority — all operations permitted.',
  admin: 'Operational and fraud control authority. No financial exports, payout approval, or commission tier assignment.',
}
