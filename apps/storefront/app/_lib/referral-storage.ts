const APP_REFERRAL_STORAGE_KEY = 'gtg-app-referral-v1'
const APP_REFERRAL_CODE_FORMAT = /^[A-Z0-9][A-Z0-9-]{0,19}$/

export function isValidAppReferralCode(code: string): boolean {
  return APP_REFERRAL_CODE_FORMAT.test(code)
}

export function captureAppReferralCode(): string | null {
  if (typeof window === 'undefined') return null

  const url = new URL(window.location.href)
  const rawCode = url.searchParams.get('ref')?.trim().toUpperCase() ?? ''

  if (rawCode && isValidAppReferralCode(rawCode)) {
    try {
      window.localStorage.setItem(APP_REFERRAL_STORAGE_KEY, rawCode)
    } catch {
      // Ignore storage failures and continue without persistence.
    }

    url.searchParams.delete('ref')
    window.history.replaceState(null, '', url.toString())
    return rawCode
  }

  return loadAppReferralCode()
}

export function loadAppReferralCode(): string | null {
  if (typeof window === 'undefined') return null

  try {
    const stored = window.localStorage.getItem(APP_REFERRAL_STORAGE_KEY)
    if (!stored) return null
    return isValidAppReferralCode(stored) ? stored : null
  } catch {
    return null
  }
}
