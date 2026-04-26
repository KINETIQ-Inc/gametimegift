/**
 * LoginPage — "/" for the admin portal.
 *
 * Email + password sign-in via Supabase auth.
 * On success: redirects to /dashboard.
 * If already authenticated: redirects to /dashboard immediately.
 */

import { type FormEvent, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { toUserMessage } from '@gtg/api'
import { useAuth } from '../useAuth'

export function LoginPage() {
  const { session, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="login-loading" aria-label="Checking session…">
        <div className="admin-loading-spinner" />
      </div>
    )
  }

  if (session) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signIn(email.trim(), password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(toUserMessage(err, 'Sign in failed. Check your credentials.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-brand">
          <span className="admin-login-brand-mark">GTG</span>
          <span className="admin-login-brand-label">Admin Portal</span>
        </div>

        <Heading as="h1" display={false}>Admin sign in</Heading>
        <p className="admin-login-sub">
          Access requires an admin or super_admin role. Contact your administrator if you need access.
        </p>

        {error ? (
          <AlertBanner kind="error">{error}</AlertBanner>
        ) : null}

        <form className="admin-login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="admin-email">Email</label>
          <input
            id="admin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
            required
            disabled={submitting}
          />

          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
            disabled={submitting}
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            className="admin-login-submit"
          >
            Sign In
          </Button>
        </form>
      </div>
    </div>
  )
}
