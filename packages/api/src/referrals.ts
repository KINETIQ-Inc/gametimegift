import { assertUuidV4 } from './_internal'
import { ApiRequestError } from './error'
import { invokeFunction } from './transport'

export interface GetReferralLinkInput {
  consultantId?: string
}

export interface GetReferralLinkResult {
  consultant_id: string
  display_name: string
  referral_code: string
  referral_url: string
  share_text: string
  lifetime_gross_sales_cents: number
  lifetime_commissions_cents: number
  total_referred_orders: number | null
}

/**
 * Fetch a consultant referral link from the server-side get-referral-link function.
 *
 * Consultants should call with no input to retrieve their own link.
 * Admins may provide consultantId to retrieve a specific consultant link.
 */
export async function getReferralLink(
  input: GetReferralLinkInput = {},
): Promise<GetReferralLinkResult> {
  const { consultantId } = input

  if (consultantId !== undefined) {
    if (typeof consultantId !== 'string' || consultantId.trim() === '') {
      throw new ApiRequestError('[GTG] getReferralLink(): consultantId must be a non-empty string when provided.', 'VALIDATION_ERROR')
    }
    assertUuidV4(consultantId.trim(), 'consultantId', 'getReferralLink')
  }

  return invokeFunction<GetReferralLinkResult>(
    'get-referral-link',
    consultantId ? { consultant_id: consultantId.trim() } : {},
    'getReferralLink',
  )
}
