/**
 * SiteNav — persistent top navigation bar used across all pages.
 *
 * Two visual modes:
 *   'dark'  — rendered on dark/navy backgrounds (homepage hero)
 *   'light' — rendered on white/light backgrounds (shop, product, consultant)
 *
 * The nav does not manage state itself. Cart count is read from StorefrontContext.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStorefront } from '../../contexts/StorefrontContext'
import { useStorefrontSession } from '../../contexts/StorefrontSessionContext'
import gameTimeGiftLogo from '../../assets/game_time_gift.png'

interface SiteNavProps {
  mode?: 'dark' | 'light'
}

export function SiteNav({ mode = 'light' }: SiteNavProps) {
  const { cart, cartCount, checkoutEnabled } = useStorefront()
  const { isCustomer } = useStorefrontSession()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    function handleResize() {
      if (window.innerWidth > 1180) {
        setMenuOpen(false)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <nav
      className={`site-nav site-nav--${mode} ${menuOpen ? 'site-nav--menu-open' : ''}`}
      aria-label="Main navigation"
    >
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Link to="/" className="site-nav__brand" aria-label="Game Time Gift — home">
        <img src={gameTimeGiftLogo} alt="" className="site-nav__logo" />
        <span className="site-nav__brand-name">Game Time Gift</span>
      </Link>

      <button
        type="button"
        className="site-nav__menu-toggle"
        aria-expanded={menuOpen}
        aria-controls="site-nav-links"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <span />
        <span />
        <span />
      </button>

      <ul className="site-nav__links" id="site-nav-links" role="list">
        <li><Link to="/shop" className="site-nav__link" onClick={() => setMenuOpen(false)}>Shop</Link></li>
        <li><Link to="/authenticity" className="site-nav__link" onClick={() => setMenuOpen(false)}>Authenticity</Link></li>
        <li><Link to="/consultant" className="site-nav__link" onClick={() => setMenuOpen(false)}>Consultants</Link></li>
        <li>
          <Link
            to={isCustomer ? '/account/orders' : '/account/sign-in'}
            className="site-nav__link"
            onClick={() => setMenuOpen(false)}
          >
            {isCustomer ? 'Account' : 'Sign In'}
          </Link>
        </li>
      </ul>

      <div className="site-nav__actions">
        <Link
          to={cart[0]?.sku ? `/checkout?sku=${cart[0].sku}` : '/checkout'}
          className="site-nav__cart"
          aria-label={`Cart — ${cartCount} item${cartCount === 1 ? '' : 's'}`}
          aria-disabled={!checkoutEnabled}
          onClick={(event) => {
            if (!checkoutEnabled) {
              event.preventDefault()
            }
          }}
        >
          <span className="site-nav__cart-icon" aria-hidden="true">
            <svg width="17" height="19" viewBox="0 0 17 19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 7C5 4.515 6.515 3 8.5 3S12 4.515 12 7" />
              <path d="M1.5 7h14l-1.4 10.5H2.9L1.5 7z" />
              {cartCount > 0 ? (
                <text x="8.5" y="14.5" textAnchor="middle" stroke="none" fill="currentColor" fontSize="5.5" fontWeight="800" fontFamily="system-ui, sans-serif">
                  {cartCount > 9 ? '9+' : cartCount}
                </text>
              ) : null}
            </svg>
          </span>
          <span className="site-nav__cart-label">Cart</span>
        </Link>
      </div>
    </nav>
  )
}
