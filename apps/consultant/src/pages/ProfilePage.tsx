/**
 * ProfilePage — "/profile"
 *
 * View and edit the authenticated consultant's profile:
 *   display name, contact email, phone, mailing address.
 *
 * Legal name and tax fields are read-only (managed via separate onboarding).
 */

import { type FormEvent, useEffect, useState } from 'react'
import {
  getConsultantProfile,
  isTransientError,
  toUserMessage,
  updateConsultantProfile,
} from '@gtg/api'
import { AlertBanner, Button, Heading, InlineMessage, SectionIntro } from '@gtg/ui'

export function ProfilePage() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Loaded profile values (read-only display)
  const [legalName, setLegalName] = useState('')
  const [tier, setTier] = useState('')
  const [status, setStatus] = useState('')

  // Editable fields
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  useEffect(() => {
    async function load(): Promise<void> {
      setLoading(true)
      setLoadError(null)
      try {
        const profile = await getConsultantProfile()
        if (!profile) {
          setLoadError('Profile not found. Contact support if this persists.')
          return
        }
        setLegalName(`${String(profile.legal_first_name ?? '')} ${String(profile.legal_last_name ?? '')}`.trim())
        setTier(String(profile.commission_tier ?? ''))
        setStatus(String(profile.status ?? ''))
        setDisplayName(String(profile.display_name ?? ''))
        setEmail(String(profile.email ?? ''))
        setPhone(String(profile.phone ?? ''))
      } catch (err) {
        setLoadError(toUserMessage(err, 'Failed to load profile.'))
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSaveError(null)
    setSaveSuccess(false)
    setSubmitting(true)

    try {
      await updateConsultantProfile({
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || null,
      })
      setSaveSuccess(true)
    } catch (err) {
      setSaveError(toUserMessage(err, 'Failed to save profile.'))
      if (!isTransientError(err)) {
        // non-transient — show as-is
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="profile-page">
        <div className="dashboard-skeleton-grid" role="status" aria-label="Loading profile">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="dashboard-skeleton-card">
              <div className="skeleton-line medium" />
              <div className="skeleton-line wide" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="profile-page">
      <SectionIntro
        eyebrow="Profile"
        title="Your account details."
        description="Update your display name, contact info, and mailing address. Legal name and tax information are managed through the onboarding process."
      />

      {loadError ? (
        <AlertBanner kind="error">{loadError}</AlertBanner>
      ) : null}

      {/* ── Read-only account details ── */}
      <section className="detail-card profile-readonly">
        <div className="detail-card-head">
          <Heading as="h3" display={false}>Account Information</Heading>
          <p>Managed by Game Time Gift — contact support to update.</p>
        </div>
        <dl className="profile-dl">
          <dt>Legal name</dt>
          <dd>{legalName || '—'}</dd>
          <dt>Commission tier</dt>
          <dd>{tier || '—'}</dd>
          <dt>Account status</dt>
          <dd>{status || '—'}</dd>
        </dl>
      </section>

      {/* ── Editable fields ── */}
      <section className="detail-card">
        <div className="detail-card-head">
          <Heading as="h3" display={false}>Contact Details</Heading>
          <p>These fields are editable and update immediately.</p>
        </div>

        {saveSuccess ? (
          <InlineMessage kind="success">Profile updated successfully.</InlineMessage>
        ) : null}
        {saveError ? (
          <InlineMessage kind="error">{saveError}</InlineMessage>
        ) : null}

        <form className="profile-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="profile-display-name">Display name</label>
          <input
            id="profile-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="How your name appears to customers"
            disabled={submitting}
            required
          />

          <label htmlFor="profile-email">Contact email</label>
          <input
            id="profile-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            disabled={submitting}
            required
          />

          <label htmlFor="profile-phone">Phone (optional)</label>
          <input
            id="profile-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 (555) 000-0000"
            disabled={submitting}
          />

          <div className="profile-form-actions">
            <Button type="submit" variant="primary" loading={submitting}>
              Save Changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setSaveSuccess(false)
                setSaveError(null)
              }}
            >
              Discard
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}
