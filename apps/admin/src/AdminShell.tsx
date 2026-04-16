/**
 * AdminShell — authenticated layout wrapper for all admin pages.
 *
 * Calls useAdminDashboard() once and distributes its state to all
 * child routes via React Router Outlet context. Each page calls
 * useAdminState() to receive the shared state.
 *
 * Also renders AdminNav, AdminPageHeader, and StatusBanners so
 * individual pages don't need to repeat those.
 */

import { Navigate, NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { Button } from '@gtg/ui'
import { useAuth } from './auth'
import { useAdminDashboard } from './hooks/use-admin-dashboard'
import { StatusBanners } from './components/StatusBanners'

export type AdminDashboardState = ReturnType<typeof useAdminDashboard>

const NAV_LINKS = [
  { to: '/dashboard', label: 'Products' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/royalties', label: 'Royalties' },
  { to: '/commissions', label: 'Commissions' },
  { to: '/fraud', label: 'Fraud' },
  { to: '/consultants', label: 'Consultants' },
  { to: '/payouts', label: 'Payouts' },
] as const

export function AdminShell() {
  const { session, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="admin-loading" aria-label="Checking session…">
        <div className="admin-loading-spinner" />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/" replace />
  }

  return <AdminShellInner signOut={signOut} />
}

function AdminShellInner({ signOut }: { signOut: () => Promise<void> }) {
  const dashState = useAdminDashboard()

  return (
    <div className="admin-layout">
      <nav className="admin-nav" aria-label="Admin navigation">
        <div className="admin-nav__brand">
          <span className="admin-nav__brand-mark">GTG</span>
          <span className="admin-nav__brand-label">Admin</span>
        </div>

        <ul className="admin-nav__links" role="list">
          {NAV_LINKS.map(({ to, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `admin-nav__link${isActive ? ' admin-nav__link--active' : ''}`
                }
              >
                {label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="admin-nav__footer">
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </nav>

      <main className="admin-content">
        <StatusBanners
          errorMessage={dashState.errorMessage}
          successMessage={dashState.successMessage}
          onRetry={dashState.retryFn?.fn}
        />
        <Outlet context={dashState} />
      </main>
    </div>
  )
}

export function useAdminState(): AdminDashboardState {
  return useOutletContext<AdminDashboardState>()
}
