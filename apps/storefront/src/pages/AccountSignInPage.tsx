import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { toUserMessage } from '@gtg/api'
import { AccountShell } from '../components/account/AccountShell'
import { useStorefrontSession } from '../contexts/StorefrontSessionContext'

function getRedirectTarget(search: string): string {
  const params = new URLSearchParams(search)
  const next = params.get('next')
  return next && next.startsWith('/account/') ? next : '/account/orders'
}

export function AccountSignInPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    isCustomer,
    signInCustomer,
    requestCustomerPasswordReset,
  } = useStorefrontSession()

  const [mode, setMode] = useState<'sign-in' | 'reset'>(
    new URLSearchParams(location.search).get('reset') === '1' ? 'reset' : 'sign-in',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const searchParams = new URLSearchParams(location.search)
  const created = searchParams.get('created') === '1'
  const confirmRequired = searchParams.get('confirm') === '1'

  useEffect(() => {
    if (isCustomer) {
      navigate(getRedirectTarget(location.search), { replace: true })
    }
  }, [isCustomer, location.search, navigate])

  useEffect(() => {
    if (!created) return
    setMode('sign-in')
    setErrorMessage('')
    setSuccessMessage(
      confirmRequired
        ? 'Account Created. Check your email to confirm your address, then sign in.'
        : 'Account Created. You can sign in now.',
    )
  }, [confirmRequired, created])

  async function handleSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      await signInCustomer({ email, password })
      navigate(getRedirectTarget(location.search), { replace: true })
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Unable to sign in right now.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handlePasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      await requestCustomerPasswordReset({
        email,
        redirectTo: `${window.location.origin}/account/sign-in?reset=1`,
      })
      setSuccessMessage('Password reset instructions have been sent to your email.')
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Unable to send the reset email right now.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccountShell
      eyebrow="Customer Account"
      title="Sign in and pick up where you left off."
      intro="Use your Game Time Gift account to review orders, update gifting details, and keep checkout faster the next time around."
    >
      <div className="account-form-shell">
        <div className="account-form-switch" role="tablist" aria-label="Sign in or reset password">
          <button
            type="button"
            className={mode === 'sign-in' ? 'is-active' : undefined}
            onClick={() => {
              setMode('sign-in')
              setErrorMessage('')
              setSuccessMessage('')
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={mode === 'reset' ? 'is-active' : undefined}
            onClick={() => {
              setMode('reset')
              setErrorMessage('')
              setSuccessMessage('')
            }}
          >
            Reset Password
          </button>
        </div>

        {errorMessage ? <AlertBanner kind="error">{errorMessage}</AlertBanner> : null}
        {successMessage ? <AlertBanner kind="success">{successMessage}</AlertBanner> : null}

        {mode === 'sign-in' ? (
          <form className="account-form" onSubmit={(event) => void handleSignIn(event)}>
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
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <Button type="submit" variant="gold" size="lg" disabled={submitting}>
              {submitting ? 'Signing In…' : 'Sign In'}
            </Button>
          </form>
        ) : (
          <form className="account-form" onSubmit={(event) => void handlePasswordReset(event)}>
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
            <Button type="submit" variant="gold" size="lg" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send Reset Link'}
            </Button>
          </form>
        )}

        <div className="account-inline-note">
          <Heading as="h2" display={false}>Need an account?</Heading>
          <p>
            Create an account to save your details and review customer orders in one place.
          </p>
          <Link to="/account/create">Create your account</Link>
        </div>
      </div>
    </AccountShell>
  )
}
