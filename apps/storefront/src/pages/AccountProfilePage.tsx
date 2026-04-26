import { useEffect, useState } from 'react'
import { AlertBanner, Button } from '@gtg/ui'
import {
  getMyCustomerProfile,
  saveMyCustomerProfile,
  toUserMessage,
} from '@gtg/api'
import { AccountShell } from '../components/account/AccountShell'
import { useStorefrontSession } from '../contexts/StorefrontSessionContext'

export function AccountProfilePage() {
  const { currentUserEmail } = useStorefrontSession()
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [shippingLine1, setShippingLine1] = useState('')
  const [shippingLine2, setShippingLine2] = useState('')
  const [shippingCity, setShippingCity] = useState('')
  const [shippingState, setShippingState] = useState('')
  const [shippingZip, setShippingZip] = useState('')
  const [marketingEmailOptIn, setMarketingEmailOptIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  useEffect(() => {
    let active = true

    async function load(): Promise<void> {
      try {
        const profile = await getMyCustomerProfile()
        if (!active || !profile) return

        setFullName(profile.full_name ?? '')
        setPhone(profile.phone ?? '')
        setShippingLine1(typeof profile.default_shipping_address === 'object' && profile.default_shipping_address && 'line1' in profile.default_shipping_address ? String(profile.default_shipping_address.line1 ?? '') : '')
        setShippingLine2(typeof profile.default_shipping_address === 'object' && profile.default_shipping_address && 'line2' in profile.default_shipping_address ? String(profile.default_shipping_address.line2 ?? '') : '')
        setShippingCity(typeof profile.default_shipping_address === 'object' && profile.default_shipping_address && 'city' in profile.default_shipping_address ? String(profile.default_shipping_address.city ?? '') : '')
        setShippingState(typeof profile.default_shipping_address === 'object' && profile.default_shipping_address && 'state' in profile.default_shipping_address ? String(profile.default_shipping_address.state ?? '') : '')
        setShippingZip(typeof profile.default_shipping_address === 'object' && profile.default_shipping_address && 'postalCode' in profile.default_shipping_address ? String(profile.default_shipping_address.postalCode ?? '') : '')
        setMarketingEmailOptIn(profile.marketing_email_opt_in)
      } catch (error) {
        if (!active) return
        setErrorMessage(toUserMessage(error, 'Unable to load your profile right now.'))
      } finally {
        if (!active) return
        setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      await saveMyCustomerProfile({
        fullName,
        phone,
        marketingEmailOptIn,
        defaultShippingAddress: shippingLine1.trim()
          ? {
              line1: shippingLine1.trim(),
              line2: shippingLine2.trim() || null,
              city: shippingCity.trim(),
              state: shippingState.trim(),
              postalCode: shippingZip.trim(),
              country: 'US',
            }
          : null,
      })
      setSuccessMessage('Profile saved.')
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Unable to save your profile right now.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AccountShell
      eyebrow="Profile"
      title="Keep the details that make checkout easier."
      intro="Your email is anchored to the account, while the rest of this profile helps the storefront pre-fill the details you use most."
    >
      {loading ? <p className="account-empty-state">Loading your profile…</p> : null}
      {errorMessage ? <AlertBanner kind="error">{errorMessage}</AlertBanner> : null}
      {successMessage ? <AlertBanner kind="success">{successMessage}</AlertBanner> : null}

      <form className="account-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          Email address
          <input type="email" value={currentUserEmail ?? ''} readOnly />
        </label>
        <label>
          Full name
          <input
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>

        <div className="account-form__grid">
          <label className="account-form__span-2">
            Default shipping address
            <input
              type="text"
              autoComplete="address-line1"
              value={shippingLine1}
              onChange={(event) => setShippingLine1(event.target.value)}
            />
          </label>
          <label className="account-form__span-2">
            Address line 2
            <input
              type="text"
              autoComplete="address-line2"
              value={shippingLine2}
              onChange={(event) => setShippingLine2(event.target.value)}
            />
          </label>
          <label>
            City
            <input
              type="text"
              autoComplete="address-level2"
              value={shippingCity}
              onChange={(event) => setShippingCity(event.target.value)}
            />
          </label>
          <label>
            State
            <input
              type="text"
              autoComplete="address-level1"
              value={shippingState}
              onChange={(event) => setShippingState(event.target.value)}
            />
          </label>
          <label>
            ZIP
            <input
              type="text"
              autoComplete="postal-code"
              value={shippingZip}
              onChange={(event) => setShippingZip(event.target.value)}
            />
          </label>
        </div>

        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={marketingEmailOptIn}
            onChange={(event) => setMarketingEmailOptIn(event.target.checked)}
          />
          <span>Keep me on the email list for launches, gifting windows, and restocks.</span>
        </label>

        <Button type="submit" variant="gold" size="lg" disabled={saving}>
          {saving ? 'Saving…' : 'Save Profile'}
        </Button>
      </form>
    </AccountShell>
  )
}
