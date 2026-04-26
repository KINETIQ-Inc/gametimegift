/**
 * PortalNav — sidebar navigation for the consultant portal.
 *
 * Renders the nav links and sign-out button.
 * Active link detection uses NavLink from react-router-dom.
 */

import { NavLink } from 'react-router-dom'
import { Button } from '@gtg/ui'
import { useAuth } from '../useAuth'

const NAV_LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/earnings', label: 'Earnings' },
  { to: '/referrals', label: 'Referral Tools' },
  { to: '/profile', label: 'Profile' },
] as const

export function PortalNav() {
  const { signOut } = useAuth()

  return (
    <nav className="portal-nav" aria-label="Consultant portal navigation">
      <div className="portal-nav__brand">
        <span className="portal-nav__brand-mark">GTG</span>
        <span className="portal-nav__brand-label">Consultant</span>
      </div>

      <ul className="portal-nav__links" role="list">
        {NAV_LINKS.map(({ to, label }) => (
          <li key={to}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                `portal-nav__link${isActive ? ' portal-nav__link--active' : ''}`
              }
            >
              {label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="portal-nav__footer">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </div>
    </nav>
  )
}
