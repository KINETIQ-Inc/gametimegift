/**
 * ReferralToolsPage — "/referrals"
 *
 * Referral link generation, copy, and channel-specific share links.
 * Lifetime referral stats displayed below the link.
 */

import { type FormEvent, useMemo, useState } from 'react'
import { AlertBanner, Button, EmptyState, Heading, SectionIntro } from '@gtg/ui'
import {
  getReferralLink,
  isTransientError,
  toUserMessage,
  type GetReferralLinkResult,
} from '@gtg/api'
import { buildChannelReferralLinks, getReferralHeadline } from '../revenue-engine'

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

export function ReferralToolsPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [result, setResult] = useState<GetReferralLinkResult | null>(null)

  const channelLinks = useMemo(
    () => (result ? buildChannelReferralLinks(result.referral_url) : []),
    [result],
  )

  async function fetchLink(): Promise<void> {
    setLoading(true)
    setError(null)
    setRetryable(false)
    setCopyState('idle')
    try {
      const data = await getReferralLink()
      setResult(data)
    } catch (err) {
      setError(toUserMessage(err, 'Failed to generate referral link.'))
      if (isTransientError(err)) setRetryable(true)
    } finally {
      setLoading(false)
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void fetchLink()
  }

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className="referral-tools-page">
      <SectionIntro
        eyebrow="Referral Tools"
        title={getReferralHeadline(result)}
        description="Share your unique link anywhere — text, email, social. Every order placed through it is attributed to you and earns commission automatically."
      />

      <section className="panel referral-panel">
        <form className="referral-form" onSubmit={onSubmit}>
          <Button type="submit" variant="primary" loading={loading}>
            {loading ? 'Generating…' : result ? 'Refresh My Link' : 'Get My Link'}
          </Button>
        </form>

        {error ? (
          <AlertBanner
            kind="error"
            actionLabel={retryable ? 'Try again' : undefined}
            onAction={retryable ? () => void fetchLink() : undefined}
          >
            {error}
          </AlertBanner>
        ) : null}

        {result ? (
          <article className="result-card">
            <div className="result-card-head">
              <div>
                <Heading as="h3" display={false}>{result.display_name}</Heading>
                <p>Code <strong>{result.referral_code}</strong></p>
              </div>
              <Button
                variant="secondary"
                onClick={() => void copyText(result.referral_url)}
              >
                {copyState === 'copied' ? 'Copied!' : 'Copy Link'}
              </Button>
            </div>

            <div className="referral-url-block">
              <p className="url">{result.referral_url}</p>
              <p className="share-text">{result.share_text}</p>
            </div>

            {copyState !== 'idle' ? (
              <p className="copy-feedback">
                {copyState === 'copied' ? 'Copied to clipboard.' : 'Copy failed — try manually selecting the URL.'}
              </p>
            ) : null}

            <div className="mini-stats">
              <p>Orders attributed: <strong>{result.total_referred_orders ?? 0}</strong></p>
              <p>Lifetime gross: <strong>{formatCurrency(result.lifetime_gross_sales_cents)}</strong></p>
              <p>Lifetime commission: <strong>{formatCurrency(result.lifetime_commissions_cents)}</strong></p>
            </div>

            {channelLinks.length > 0 ? (
              <div className="channel-grid">
                {channelLinks.map((link) => (
                  <article key={link.channel} className="channel-card">
                    <span>{link.label}</span>
                    <p>{link.href}</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void copyText(link.href)}
                    >
                      Copy {link.label}
                    </Button>
                  </article>
                ))}
              </div>
            ) : null}
          </article>
        ) : (
          !loading ? (
            <EmptyState
              className="empty-state"
              title="Your link isn't generated yet."
              description="Click 'Get My Link' to get your personal referral URL and share links."
            />
          ) : null
        )}
      </section>
    </div>
  )
}
