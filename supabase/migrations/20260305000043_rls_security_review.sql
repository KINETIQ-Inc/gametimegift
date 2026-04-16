-- =============================================================================
-- Migration: 20260305000043_rls_security_review
--
-- Phase 7A-1 — Security Review: RLS policy audit and corrections.
--
-- ─── Scope ────────────────────────────────────────────────────────────────────
--
-- All 13 user-facing tables reviewed. One broken policy found and fixed.
-- One coverage gap closed. Two shared helper functions added.
--
-- ─── Tables reviewed ──────────────────────────────────────────────────────────
--
--   Table                        Status        Migration
--   ────────────────────────────────────────────────────────────────
--   products                     CORRECT       migration 01
--   serialized_units             BUG FIXED     migration 02 → this migration
--   manufacturing_batches        CORRECT       migration 03
--   consultant_profiles          CORRECT       migration 05
--   orders                       CORRECT       migration 06
--   order_lines                  CORRECT       migration 07
--   inventory_ledger_entries     CORRECT       migration 08
--   commission_entries           CORRECT       migration 09
--   royalty_entries              CORRECT       migration 10
--   fraud_flags                  CORRECT       migration 11
--   lock_records                 CORRECT       migration 12
--   payment_events               CORRECT       migration 14
--   commission_tier_config       CORRECT       migration 21
--   order_number_counters        CORRECT       migration 38
--
-- ─── Bug: serialized_units_select_consultant_own ──────────────────────────────
--
-- The original policy contained:
--   consultant_id = auth.uid()
--
-- This is INCORRECT. serialized_units.consultant_id references
-- consultant_profiles.id — a profile UUID, not an auth.users.id.
-- auth.uid() returns the user's auth.users.id.
--
-- Because the two UUID namespaces are completely separate, no consultant's
-- auth.uid() will ever equal a consultant_profiles.id. In practice, the policy
-- would always evaluate to false, silently denying consultants access to their
-- own units when querying via the user client. Edge Functions are unaffected
-- because they use the admin client (service_role), which bypasses RLS.
--
-- Fix: replace the equality check with a subquery that resolves the profile id.
--
-- ─── Gap: serialized_units available units visible to anon ────────────────────
--
-- The products table grants SELECT to anon for public storefront browsing
-- (migration 01: products_select_active). The serialized_units available-units
-- policy (migration 02: serialized_units_select_available) is scoped to
-- authenticated only. This is inconsistent: a public storefront visitor (anon
-- key) cannot directly query unit availability even though product visibility
-- is public.
--
-- All current production queries for available unit counts go through Edge
-- Functions (admin client), so this gap has no current operational impact.
-- Adding the anon policy closes the gap for defense-in-depth and for any
-- future direct PostgREST queries from the public storefront.
--
-- ─── Shared helper functions ──────────────────────────────────────────────────
--
-- All existing policies inline the JWT role check as:
--   (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
--
-- This pattern is repeated across ~20 policy definitions in 10 migrations.
-- Two STABLE SECURITY DEFINER helper functions are added here to provide
-- a canonical, testable form for all future policies. Existing policies are
-- not retroactively rewritten — they are correct and changing them would
-- produce noisy diffs with zero security benefit.
--
-- ─── All writes go through service_role ───────────────────────────────────────
--
-- All INSERT / UPDATE operations on every GTG table are performed via the
-- admin client (service_role key) inside Edge Functions. service_role bypasses
-- RLS entirely, so the INSERT/UPDATE/DELETE policies in each migration are a
-- defence-in-depth guard for direct API access, not the primary access control
-- mechanism. This review confirms that all such write policies are correctly
-- scoped to admin roles only.
--
-- ─── Role model ───────────────────────────────────────────────────────────────
--
-- Roles are stored in auth.users.app_metadata.role (server-set; cannot be
-- spoofed by a client JWT claim). The JWT exposes them as:
--   auth.jwt() -> 'app_metadata' ->> 'role'
--
-- Role values in use:
--   admin             Internal GTG administrator
--   super_admin       Elevated admin with destructive-action privileges
--   consultant        Registered sales consultant
--   customer          Authenticated storefront customer (role may be absent)
--   licensor_auditor  Read-only auditor for CLC/Army compliance review
-- =============================================================================


-- ─── Shared helper functions ──────────────────────────────────────────────────

-- gtg_current_role()
-- Returns the GTG application role from the current JWT's app_metadata.
-- Role is set server-side via Supabase auth admin APIs.
-- Clients cannot influence this value through their own JWT claims.
-- Returns null for sessions without a role (e.g. unauthenticated service calls).

create or replace function public.gtg_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth.jwt() -> 'app_metadata' ->> 'role'
$$;

comment on function public.gtg_current_role() is
  'Returns the GTG application role from the current JWT app_metadata.role claim. '
  'Role is server-set and cannot be spoofed by clients. '
  'Returns null when no role is present (unauthenticated or unassigned users). '
  'Use in RLS policy USING/WITH CHECK expressions.';


-- gtg_is_admin()
-- Returns true when the current role is admin or super_admin.
-- Convenience wrapper for the most common RLS admin check.

create or replace function public.gtg_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gtg_current_role() in ('admin', 'super_admin')
$$;

comment on function public.gtg_is_admin() is
  'Returns true when the current JWT role is ''admin'' or ''super_admin''. '
  'Convenience wrapper for the admin check in RLS USING expressions. '
  'New migrations should prefer this over inlining the JWT path.';


-- ─── Fix: serialized_units_select_consultant_own ──────────────────────────────
-- Drop the incorrect policy and replace it with a subquery-based check.
-- The subquery resolves the caller's auth.users.id → consultant_profiles.id
-- so that the comparison is between UUIDs in the same namespace.
--
-- Security note: the subquery executes in the context of the SECURITY DEFINER
-- function (if any), or the caller's role. Since consultant_profiles has its own
-- RLS, the subquery result is filtered to rows the caller can see. This is safe:
--   - Only the consultant's own auth_user_id matches auth.uid().
--   - An admin calling this would match the admin policies instead.
--
-- Index: serialized_units_consultant_id_idx (partial, on non-null consultant_id)
-- already exists from migration 02. The subquery uses the unique constraint index
-- on consultant_profiles.auth_user_id (added by consultant_profiles_auth_user_unique).
-- Both sides of the join are indexed; the lookup is efficient.

drop policy if exists "serialized_units_select_consultant_own"
  on public.serialized_units;

create policy "serialized_units_select_consultant_own"
  on public.serialized_units
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'consultant'
    and consultant_id in (
      select id
      from public.consultant_profiles
      where auth_user_id = auth.uid()
    )
  );

comment on policy "serialized_units_select_consultant_own"
  on public.serialized_units is
  'Consultants may read serialized units linked to their own consultant profile. '
  'Uses a subquery to resolve auth.uid() → consultant_profiles.id because '
  'serialized_units.consultant_id references the profile primary key, not auth.users.id. '
  'Replaces the incorrect direct equality (consultant_id = auth.uid()) from migration 02.';


-- ─── Gap closure: serialized_units available units for anon ──────────────────
-- Anon (unauthenticated) sessions can query available unit counts for the
-- public storefront, consistent with the products SELECT anon policy.
-- Only units with status = 'available' are visible; sold, returned, fraud_locked,
-- reserved, and voided units are not exposed to unauthenticated callers.

create policy "serialized_units_select_available_anon"
  on public.serialized_units
  for select
  to anon
  using (status = 'available');

comment on policy "serialized_units_select_available_anon"
  on public.serialized_units is
  'Unauthenticated (anon) sessions may see units with status = ''available''. '
  'Consistent with products_select_active which allows anon browsing of the catalog. '
  'Sold, reserved, returned, fraud_locked, and voided units are never exposed.';
