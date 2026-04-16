/**
 * Referral Attribution — capture, persist, and clear consultant attribution.
 *
 * ─── ATTRIBUTION RULES ────────────────────────────────────────────────────────
 *
 * CAPTURE
 *   Source:   ?ref=CODE in the URL query string only. Not the hash, not POST.
 *   Format:   1–20 characters. A–Z, 0–9, and hyphens only (see CODE_FORMAT).
 *   Timing:   Captured on app mount. URL param cleaned immediately via
 *             replaceState so the code is not visible in browser history or
 *             bookmarks after the initial landing.
 *   Storage:  localStorage.
 *             Attribution persists across refreshes and later visits until the
 *             customer dismisses it or completes an order.
 *
 * PRIORITY
 *   URL param wins over localStorage. If a customer arrives with a new
 *   ?ref= code, it replaces any attribution stored from a previous page load
 *   in the same session. This handles share-link refreshes correctly.
 *   Only one active attribution exists per session at any time.
 *
 * VALIDATION
 *   Format:   Checked client-side against CODE_FORMAT before storage.
 *             Malformed codes are silently discarded — never stored, never shown.
 *   Existence: resolveConsultantCode() performs the server-side existence check.
 *             Codes that pass format validation but match no active consultant
 *             are silently discarded — the banner never appears for unknown codes.
 *
 * DISPLAY
 *   A ConsultantAttributionBanner renders only after resolveConsultantCode()
 *   returns a valid result. The banner shows the consultant's display name.
 *   The customer may dismiss the banner. Dismissal clears stored attribution
 *   and cannot be undone by reloading (the ?ref= param was already removed
 *   from the URL at capture time).
 *
 * CHECKOUT INJECTION
 *   The CheckoutPage pre-fills the consultant code field with the active code.
 *   The field is editable — the customer may override or clear it.
 *   createOrder() receives the resolved consultantId (UUID). Attribution is
 *   attached at the order level, not the session level.
 *
 * CLEARANCE
 *   · After a confirmed order (OrderConfirmation mounts).
 *   · After the customer dismisses the attribution banner.
 *   · When the customer explicitly clears attribution.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ATTRIBUTION_STORAGE_KEY = 'gtg-referral-attribution-v1'

/**
 * Canonical referral code format: 1–20 characters, A–Z / 0–9 / hyphens.
 * GTG-XXXXX is the standard pattern but any conforming string is accepted.
 */
const CODE_FORMAT = /^[A-Z0-9][A-Z0-9-]{0,19}$/

// ─── Stored Attribution Contract ──────────────────────────────────────────────

export interface ReferralAttribution {
  /** The raw referral code as it appeared in the ?ref= URL param. */
  code: string
  /** ISO 8601 — when this attribution was captured from the URL. */
  capturedAt: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns true if the code meets the format contract.
 * Does NOT validate whether the consultant exists — that requires an API call.
 */
export function isValidReferralCodeFormat(code: string): boolean {
  return CODE_FORMAT.test(code)
}

// ─── Capture ─────────────────────────────────────────────────────────────────

/**
 * Read ?ref= from the current URL, validate format, write to localStorage,
 * and remove the param from the URL via replaceState.
 *
 * Call once on app mount. Idempotent — safe to call multiple times.
 *
 * Priority: URL param → existing localStorage.
 * A new URL param always replaces the stored attribution.
 *
 * Returns the captured code, or null if no valid code was present.
 */
export function captureReferralAttribution(): string | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  const raw = params.get('ref')?.trim().toUpperCase() ?? ''

  if (raw && isValidReferralCodeFormat(raw)) {
    // Write to localStorage (replaces any prior attribution).
    const attribution: ReferralAttribution = {
      code: raw,
      capturedAt: new Date().toISOString(),
    }

    try {
      window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution))
    } catch {
      // localStorage unavailable — continue without persistence.
    }

    // Remove ?ref= from the URL so it isn't bookmarked or shared with the code
    // embedded, and so browser history entries don't replay the attribution.
    const cleanUrl = new URL(window.location.href)
    cleanUrl.searchParams.delete('ref')
    window.history.replaceState(null, '', cleanUrl.toString())

    return raw
  }

  // No URL param — fall back to localStorage.
  return loadReferralAttribution()?.code ?? null
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Read the stored attribution from localStorage.
 * Returns null if nothing is stored or storage is unavailable.
 */
export function loadReferralAttribution(): ReferralAttribution | null {
  try {
    const raw = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as ReferralAttribution
  } catch {
    return null
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────

/**
 * Remove the stored attribution from localStorage.
 *
 * Call after:
 *   - A confirmed order (OrderConfirmation mounted after Stripe return).
 *   - The customer explicitly dismisses the ConsultantAttributionBanner.
 */
export function clearReferralAttribution(): void {
  try {
    window.localStorage.removeItem(ATTRIBUTION_STORAGE_KEY)
  } catch {
    // ignore
  }
}
