import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { toUserMessage } from '@gtg/api'
import { AccountShell } from '../components/account/AccountShell'
import { useStorefrontSession } from '../contexts/StorefrontSessionContext'

export function AccountCreatePage() {
  const navigate = useNavigate()
  const { isCustomer, signUpCustomer } = useStorefrontSession()

  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  useEffect(() => {
    if (isCustomer) {
      navigate('/account/profile', { replace: true })
    }
  }, [isCustomer, navigate])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setErrorMessage('')
    setSuccessMessage('')

    if (password !== confirmPassword) {
      setSubmitting(false)
      setErrorMessage('Passwords do not match.')
      return
    }

    try {
      const result = await signUpCustomer({
        email,
        password,
        fullName,
        phone,
        emailRedirectTo: `${window.location.origin}/account/sign-in`,
      })

      if (result.emailConfirmationRequired) {
        navigate('/account/sign-in?created=1&confirm=1', { replace: true })
      } else {
        navigate('/account/sign-in?created=1', { replace: true })
      }
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Unable to create your account right now.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccountShell
      eyebrow="Customer Account"
      title="Create a storefront account that stays out of the way."
      intro="Your account keeps order history, shipping details, and gifting preferences together while leaving guest checkout available whenever you need it."
    >
      <div className="account-form-shell">
        {errorMessage ? <AlertBanner kind="error">{errorMessage}</AlertBanner> : null}
        {successMessage ? <AlertBanner kind="success">{successMessage}</AlertBanner> : null}

        <form className="account-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Full name
            <input
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
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
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          <Button type="submit" variant="gold" size="lg" disabled={submitting}>
            {submitting ? 'Creating Account…' : 'Create Account'}
          </Button>
        </form>

        <div className="account-inline-note">
          <Heading as="h2" display={false}>Already registered?</Heading>
          <p>
            Sign in to see your saved profile and any orders attached to your customer account.
          </p>
          <Link to="/account/sign-in">Go to sign in</Link>
        </div>
      </div>
    </AccountShell>
  )
}
