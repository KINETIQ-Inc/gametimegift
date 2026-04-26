/**
 * App — router root for the Game Time Gift consultant portal.
 *
 * Route map:
 *   /             → LoginPage   (public — redirects to /dashboard if authed)
 *   /dashboard    → DashboardPage  (protected)
 *   /earnings     → EarningsPage   (protected)
 *   /referrals    → ReferralToolsPage (protected)
 *   /profile      → ProfilePage    (protected)
 *   * (catch-all) → redirect to /
 *
 * Auth is provided by <AuthProvider> which wraps all routes.
 * Protected pages redirect to "/" when the session is null.
 */

import { type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth'
import { useAuth } from './useAuth'
import { PortalNav } from './components/PortalNav'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { EarningsPage } from './pages/EarningsPage'
import { ReferralToolsPage } from './pages/ReferralToolsPage'
import { ProfilePage } from './pages/ProfilePage'

// ── Protected shell ───────────────────────────────────────────
// Wraps all auth-gated routes. Redirects to "/" if not signed in.
// Renders the persistent sidebar nav + page content area.

function PortalShell() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="login-loading" aria-label="Checking session…">
        <div className="login-loading-spinner" />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="portal-layout">
      <PortalNav />
      <main className="portal-content">
        <Outlet />
      </main>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return null
  if (!session) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LoginPage />} />

        {/* Protected — all share the portal shell layout */}
        <Route element={<PortalShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/earnings" element={<EarningsPage />} />
          <Route path="/referrals" element={<ReferralToolsPage />} />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfilePage />
              </ProtectedRoute>
            }
          />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
