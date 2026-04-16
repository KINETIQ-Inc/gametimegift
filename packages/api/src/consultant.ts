/**
 * Consultant self-service profile operations.
 *
 * These functions are called by authenticated consultants acting on their own
 * account. Admin-initiated changes to consultant accounts (status transitions,
 * tier assignment, profile creation) live in admin.ts.
 *
 * RLS contract: all direct table reads in this module are scoped by
 * `auth.uid() = auth_user_id` on the consultant_profiles table.
 * The query returns null — not an error — when the row is not visible
 * to the current session (unauthenticated or wrong role).
 */

import type { ConsultantAddress } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction } from './transport'
import type { Database } from './transport'

type ConsultantProfileRow = Database['public']['Tables']['consultant_profiles']['Row']

// ─── Get Profile ──────────────────────────────────────────────────────────────

export interface GetConsultantProfileInput {
  /**
   * Target consultant's consultant_profiles.id.
   *
   * Omit to retrieve the currently authenticated consultant's own profile
   * (self-scoped, RLS enforced). Admins may supply this to read any profile.
   */
  consultantId?: string
}

/**
 * Fetch a consultant profile by ID, or the current session's own profile.
 *
 * Returns null when:
 *   - The profile does not exist.
 *   - RLS hides the row from the current session.
 *   - The session is unauthenticated.
 */
export async function getConsultantProfile(
  input: GetConsultantProfileInput = {},
): Promise<ConsultantProfileRow | null> {
  const { consultantId } = input

  if (consultantId !== undefined) {
    if (typeof consultantId !== 'string' || consultantId.trim() === '') {
      throw new ApiRequestError(
        '[GTG] getConsultantProfile(): consultantId must be a non-empty string when provided.',
        'VALIDATION_ERROR',
      )
    }
    assertUuidV4(consultantId.trim(), 'consultantId', 'getConsultantProfile')
  }

  const client = getTableClient()
  const query = client.from('consultant_profiles').select('*')

  const { data, error } = consultantId
    ? await query.eq('id', consultantId.trim()).maybeSingle()
    : await query.maybeSingle()

  if (error) {
    throw new ApiRequestError(
      `[GTG] getConsultantProfile(): query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  return (data ?? null) as ConsultantProfileRow | null
}

// ─── Update Profile ───────────────────────────────────────────────────────────

export interface UpdateConsultantProfileInput {
  /** New display name. Must be non-empty if provided. */
  displayName?: string
  /** New contact email. Must be non-empty if provided. Lowercased server-side. */
  email?: string
  /** E.164 phone number (e.g. +12125550100). Pass null to clear. */
  phone?: string | null
  /** Mailing address for 1099 delivery. Pass null to clear. */
  address?: ConsultantAddress | null
}

export interface UpdateConsultantProfileResult {
  consultant_id: string
  display_name: string
  email: string
  phone: string | null
  address: ConsultantAddress | null
  updated_at: string
}

/**
 * Update mutable fields on the authenticated consultant's own profile.
 *
 * At least one field must be provided. Legal name and tax fields are
 * handled through a separate tax-onboarding flow and are not updatable here.
 *
 * Routes to the `update-consultant-profile` Edge Function so that all
 * profile mutations are server-audited and never written directly by the client.
 */
export async function updateConsultantProfile(
  input: UpdateConsultantProfileInput,
): Promise<UpdateConsultantProfileResult> {
  const { displayName, email, phone, address } = input

  if (
    displayName === undefined &&
    email === undefined &&
    phone === undefined &&
    address === undefined
  ) {
    throw new ApiRequestError(
      '[GTG] updateConsultantProfile(): at least one field must be provided.',
      'VALIDATION_ERROR',
    )
  }

  if (displayName !== undefined && displayName.trim().length === 0) {
    throw new ApiRequestError(
      '[GTG] updateConsultantProfile(): displayName cannot be blank.',
      'VALIDATION_ERROR',
    )
  }

  if (email !== undefined && email.trim().length === 0) {
    throw new ApiRequestError(
      '[GTG] updateConsultantProfile(): email cannot be blank.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<UpdateConsultantProfileResult>(
    'update-consultant-profile',
    {
      ...(displayName !== undefined ? { display_name: displayName.trim() } : {}),
      ...(email !== undefined ? { email: email.trim().toLowerCase() } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(address !== undefined ? { address } : {}),
    },
    'updateConsultantProfile',
  )
}

// ─── Resolve Consultant Code ──────────────────────────────────────────────────

export interface ResolveConsultantCodeResult {
  consultant_id: string
  display_name: string
  referral_code: string
}

/**
 * Resolve a consultant referral code to a consultant profile.
 *
 * Returns null when no active consultant has the given referral code.
 * Used by the storefront checkout to attribute a sale to a consultant
 * before calling createCheckoutSession.
 *
 * Called unauthenticated — no session required. The Edge Function
 * only exposes id, display_name, and referral_code (never financial data).
 */
export async function resolveConsultantCode(
  code: string,
): Promise<ResolveConsultantCodeResult | null> {
  const normalized = code.trim().toUpperCase()

  if (!normalized) {
    throw new ApiRequestError(
      '[GTG] resolveConsultantCode(): code is required.',
      'VALIDATION_ERROR',
    )
  }

  try {
    return await invokeFunction<ResolveConsultantCodeResult>(
      'resolve-consultant-code',
      { referral_code: normalized },
      'resolveConsultantCode',
    )
  } catch (error) {
    // BUSINESS_ERROR = no matching consultant — not a system fault.
    if (error instanceof ApiRequestError && error.code === 'BUSINESS_ERROR') {
      return null
    }
    throw error
  }
}
