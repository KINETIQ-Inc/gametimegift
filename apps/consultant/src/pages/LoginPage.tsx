/**
 * LoginPage — "/" for the consultant portal.
 *
 * Email + password sign-in via Supabase auth.
 * On success: redirects to /dashboard.
 * If already authenticated: redirects to /dashboard immediately.
 */

import { type FormEvent, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { toUserMessage } from '@gtg/api'
import { useAuth } from '../auth'

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
        <div className="login-loading-spinner" />
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
      setError(toUserMessage(err, 'Sign in failed. Check your email and password.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand-mark">GTG</span>
          <span className="login-brand-label">Consultant Portal</span>
        </div>

        <Heading as="h1" display={false}>Sign in to your account</Heading>
        <p className="login-sub">Track sales, commissions, and referral performance.</p>

        {error ? (
          <AlertBanner kind="error">{error}</AlertBanner>
        ) : null}

        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            disabled={submitting}
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
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
            className="login-submit"
          >
            Sign In
          </Button>
        </form>
      </div>
    </div>
  )
}
