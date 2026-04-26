import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button, Heading } from '@gtg/ui'
import { SiteNav } from '../nav/SiteNav'
import { StorefrontFooter } from '../footer/StorefrontFooter'
import { useStorefrontSession } from '../../contexts/useStorefrontSession'

interface AccountShellProps {
  eyebrow: string
  title: string
  intro: string
  children: ReactNode
}

export function AccountShell({ eyebrow, title, intro, children }: AccountShellProps) {
  const location = useLocation()
  const { isCustomer, signOutCustomer } = useStorefrontSession()

  useEffect(() => {
    function handleFocusIn(event: FocusEvent) {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.closest('.account-page')) return
      if (!target.matches('input, textarea, select')) return
      if (window.innerWidth > 960) return

      window.setTimeout(() => {
        target.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'smooth',
        })
      }, 180)
    }

    document.addEventListener('focusin', handleFocusIn)
    return () => {
      document.removeEventListener('focusin', handleFocusIn)
    }
  }, [])

  return (
    <>
      <main id="main-content" className="account-page">
        <div className="container">
          <SiteNav mode="light" />

          <section className="account-hero">
            <div className="account-hero__copy">
              <p className="account-hero__eyebrow">{eyebrow}</p>
              <Heading as="h1">{title}</Heading>
              <p className="account-hero__intro">{intro}</p>
            </div>

            <div className="account-hero__panel">
              <nav className="account-hero__nav" aria-label="Account navigation">
                <Link
                  to="/account/sign-in"
                  className={location.pathname === '/account/sign-in' ? 'is-active' : undefined}
                >
                  Sign In
                </Link>
                <Link
                  to="/account/create"
                  className={location.pathname === '/account/create' ? 'is-active' : undefined}
                >
                  Create Account
                </Link>
                {isCustomer ? (
                  <>
                    <Link
                      to="/account/orders"
                      className={location.pathname === '/account/orders' ? 'is-active' : undefined}
                    >
                      Orders
                    </Link>
                    <Link
                      to="/account/profile"
                      className={location.pathname === '/account/profile' ? 'is-active' : undefined}
                    >
                      Profile
                    </Link>
                  </>
                ) : null}
              </nav>

              {isCustomer ? (
                <Button type="button" variant="secondary" onClick={() => void signOutCustomer()}>
                  Sign Out
                </Button>
              ) : null}
            </div>
          </section>

          <section className="account-card gtg-card">
            {children}
          </section>
        </div>
      </main>

      <StorefrontFooter />
    </>
  )
}
