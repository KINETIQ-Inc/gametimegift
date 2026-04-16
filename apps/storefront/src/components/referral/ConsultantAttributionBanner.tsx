/**
 * ConsultantAttributionBanner — shown when the session has an active referral.
 *
 * Renders only after the referral code has been resolved server-side to a
 * valid, active consultant. Invalid codes, unknown codes, and resolution
 * errors produce no visible output — the customer never sees a broken state.
 *
 * DISPLAY RULES (from referral-attribution.ts):
 *   · Only shown when resolveConsultantCode() returns a valid result.
 *   · The customer may dismiss it. Dismissal clears stored attribution
 *     so the banner cannot reappear until a new referral link is visited.
 *   · No loading spinner is shown while resolving — the banner appears or it
 *     doesn't. Silence on failure is intentional.
 */

import { useEffect, useState } from 'react'
import { resolveConsultantCode } from '@gtg/api'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConsultantAttributionBannerProps {
  /**
   * The raw referral code to resolve (e.g. "GTG-XXXXX").
   * Null or empty string → component renders nothing.
   */
  code: string | null
  /**
   * Called when the customer dismisses the banner.
   * Parent is responsible for calling clearReferralAttribution().
   */
  onDismiss: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConsultantAttributionBanner({
  code,
  onDismiss,
}: ConsultantAttributionBannerProps) {
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Reset when code changes (e.g. dismissal followed by a new URL param).
    setDisplayName(null)
    setDismissed(false)

    if (!code) return

    let cancelled = false

    async function resolve(): Promise<void> {
      if (!code) return

      try {
        const result = await resolveConsultantCode(code)
        if (cancelled) return

        if (result) {
          setDisplayName(result.display_name)
        }
        // No else — unknown code produces no banner. Silently discard.
      } catch {
        // Resolution error — no banner. Never expose error state to the customer.
      }
    }

    void resolve()

    return () => {
      cancelled = true
    }
  }, [code])

  function handleDismiss() {
    setDismissed(true)
    onDismiss()
  }

  // Only render when resolved and not dismissed.
  if (!displayName || dismissed) return null

  return (
    <div className="attribution-banner" role="status" aria-live="polite">
      <span className="attribution-banner-icon" aria-hidden="true">✦</span>
      <span className="attribution-banner-text">
        Shopping with <strong>{displayName}</strong>
      </span>
      <button
        type="button"
        className="attribution-banner-dismiss"
        onClick={handleDismiss}
        aria-label="Remove consultant attribution"
      >
        ✕
      </button>
    </div>
  )
}
