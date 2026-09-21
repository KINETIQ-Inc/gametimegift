/**
 * Consultant referral code rules.
 *
 * Format-only validation — existence of a matching consultant is a server-side
 * check (resolveConsultantCode), not a business rule this module can express
 * without a data source.
 *
 * Moved here from `apps/storefront/src/referral-attribution.ts`, which
 * previously defined this regex locally. App code must not define business
 * rules independently — it consumes them via `@gtg/api`.
 */

/**
 * Canonical referral code format: 1–20 characters, A–Z / 0–9 / hyphens.
 * GTG-XXXXX is the standard pattern but any conforming string is accepted.
 */
const CODE_FORMAT = /^[A-Z0-9][A-Z0-9-]{0,19}$/

export function isReferralCode(code: string): boolean {
  return CODE_FORMAT.test(code)
}

export function assertReferralCode(code: string, context = 'referralCode'): asserts code is string {
  if (!isReferralCode(code)) {
    throw new Error(`[GTG] ${context} must be 1-20 characters of A-Z, 0-9, or hyphens.`)
  }
}
