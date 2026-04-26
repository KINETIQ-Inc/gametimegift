/**
 * HomePage — rendered at "/"
 *
 * Sections (in order):
 *   1. TopHero        — dark navy header with SiteNav + hero copy
 *   2. CartFlash      — transient cart confirmation banner
 *   3. AttributionBanner — consultant referral notice
 *   4. TrustBar       — NCAA / Military / Hologram / Gift-Ready trust signals
 *   5. Positioning    — "Why Game Time Gift" brand story section
 *   6. SportSelector  — filter-by-sport pill grid
 *   7. Catalog        — FeaturedCarousel + product grid
 *   8. GiftFlow       — personalized gift intent form
 *   9. DesignedToPair — editorial pairing section
 *   10. Founder       — founder story section
 *   11. Footer        — StorefrontFooter
 */

import {
  lazy,
  startTransition,
  Suspense,
} from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Heading } from '@gtg/ui'
import { useStorefront } from '../contexts/useStorefront'
import { ConsultantAttributionBanner } from '../components/referral/ConsultantAttributionBanner'
import { MegaNav } from '../components/mega-nav/MegaNav'
import { SiteNav } from '../components/nav/SiteNav'
import {
  type LicenseFilter,
  type SportFilter,
} from '../product-routing'
import type { NavTabId } from '../config/mega-nav'
import footballArt from '../assets/football.png'
import soccerArt from '../assets/soccer.png'
import basketballArt from '../assets/basketball.png'
import baseballArt from '../assets/baseball.png'
import hockeyArt from '../assets/hockey.png'
import selectorFootballArt from '../assets/selector_football.png'
import selectorSoccerArt from '../assets/selector_soccer_ball.png'
import selectorBasketballArt from '../assets/selector_basetball.png'
import selectorBaseballArt from '../assets/selector_baseball.png'
import selectorHockeyArt from '../assets/selector_hockey.png'
import gameTimeGiftLogo from '../assets/game_time_gift.png'
const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)
const DesignedToPairSection = lazy(async () =>
  import('../components/DesignedToPairSection').then((m) => ({ default: m.DesignedToPairSection })),
)
const FounderSection = lazy(async () =>
  import('../components/FounderSection').then((m) => ({ default: m.FounderSection })),
)

// ── Constants ────────────────────────────────────────────────

const SPORT_SELECTOR_ITEMS = [
  { sport: 'FOOTBALL' as const, label: 'Football', art: selectorFootballArt },
  { sport: 'BASKETBALL' as const, label: 'Basketball', art: selectorBasketballArt },
  { sport: 'SOCCER' as const, label: 'Soccer', art: selectorSoccerArt },
  { sport: 'BASEBALL' as const, label: 'Baseball', art: selectorBaseballArt },
  { sport: 'HOCKEY' as const, label: 'Hockey', art: selectorHockeyArt },
] as const

const ARMY_VASE_FEATURE_ART =
  'https://gametimegift.com/assets/products/united-states-army.png?v=2026-03-31'
const ARMY_VASE_CHECKOUT_PATH = '/checkout?sku=GTG-UNITED-STATES-ARMY-FB-001'

// ── Sub-components ────────────────────────────────────────────

function DeferredSectionFallback({ minHeight = 160 }: { minHeight?: number }) {
  return <div style={{ minHeight }} aria-hidden="true" />
}

// ── HomePage ──────────────────────────────────────────────────

export function HomePage() {
  const navigate = useNavigate()
  const {
    error,
    licenseFilter,
    sportFilter,
    setLicenseFilter,
    setSportFilter,
    cartMessage,
    activeReferralCode,
    handleDismissAttribution,
  } = useStorefront()

  function navigateToShop(nextSport: SportFilter, nextLicense: LicenseFilter): void {
    const params = new URLSearchParams()
    if (nextSport !== 'ALL') {
      params.set('sport', nextSport)
    }
    if (nextLicense !== 'ALL') {
      params.set('license', nextLicense)
    }

    navigate({
      pathname: '/shop',
      search: params.toString() ? `?${params.toString()}` : '',
    })
  }

  function handleSportSelect(sport: SportFilter) {
    startTransition(() => {
      setSportFilter(sport)
    })
    navigateToShop(sport, licenseFilter as LicenseFilter)
  }

  function handleLeagueSelect(tabId: NavTabId) {
    const nextFilters: { license: LicenseFilter; sport: SportFilter } = (() => {
      switch (tabId) {
        case 'nfl':
          return { license: 'NONE', sport: 'FOOTBALL' }
        case 'ncaa':
          return { license: 'CLC', sport: 'ALL' }
        case 'mlb':
          return { license: 'NONE', sport: 'BASEBALL' }
        case 'nba':
          return { license: 'NONE', sport: 'BASKETBALL' }
        case 'nhl':
          return { license: 'NONE', sport: 'HOCKEY' }
        case 'soccer':
          return { license: 'NONE', sport: 'SOCCER' }
        case 'military':
          return { license: 'ARMY', sport: 'ALL' }
        case 'collectibles':
          return { license: 'NONE', sport: 'ALL' }
        case 'featured':
        default:
          return { license: 'ALL', sport: 'ALL' }
      }
    })()

    startTransition(() => {
      setLicenseFilter(nextFilters.license)
      setSportFilter(nextFilters.sport)
    })
    navigateToShop(nextFilters.sport, nextFilters.license)
  }

  return (
    <>
      <main id="main-content" className="storefront">
        <div className="container">
          <div className="storefront-shell">
            {/* ── 1. Top hero (nav + headline) ── */}
            <section className="top-hero">
              <SiteNav mode="light" />

              <div className="hero-stage hero-stage--redesign">
                <div className="sport-backdrop sport-backdrop--redesign" aria-hidden="true">
                  <div className="sport-art football"><img src={footballArt} alt="" decoding="async" /></div>
                  <div className="sport-art basketball"><img src={basketballArt} alt="" decoding="async" /></div>
                  <div className="sport-art soccer"><img src={soccerArt} alt="" decoding="async" /></div>
                  <div className="sport-art baseball"><img src={baseballArt} alt="" decoding="async" /></div>
                  <div className="sport-art hockey"><img src={hockeyArt} alt="" decoding="async" /></div>
                </div>

                <div className="hero-grid">
                  <div className="hero-copy">
                    <p className="hero-eyebrow">Gift-first sports collectibles</p>
                    <Heading as="h1" className="hero-title">Sports gifting, made to feel premium.</Heading>
                    <p className="hero-keep-forever">Clean. App-like. Display-worthy.</p>
                    <p className="hero-subtext">
                      Officially licensed pieces for fans, families, and alumni — designed for real gifting moments
                      with a cleaner, elevated retail feel.
                    </p>

                    <div className="hero-actions">
                      <a href="#sport-selector" className="gtg-btn gtg-btn--gold gtg-btn--lg hero-primary-cta">
                        Shop by Sport
                      </a>
                      <Link to="/authenticity" className="hero-secondary-cta">
                        Authenticity
                      </Link>
                    </div>

                    <div className="hero-chip-row" role="list" aria-label="Shopping highlights">
                      <span className="hero-chip" role="listitem">Officially licensed</span>
                      <span className="hero-chip" role="listitem">Gift-ready presentation</span>
                      <span className="hero-chip" role="listitem">Hologram verified</span>
                    </div>

                    <p className="hero-occasion-line">Built for Father&apos;s Day, alumni gifting, host moments, and forever shelves.</p>
                  </div>

                </div>
              </div>
            </section>

            <MegaNav onFilterSelect={handleLeagueSelect} />

            {/* ── 2. Cart flash banner ── */}
            {cartMessage ? (
              <div className="cart-flash-banner" aria-live="polite">{cartMessage}</div>
            ) : null}

            {/* ── 3. Consultant attribution banner ── */}
            <ConsultantAttributionBanner
              code={activeReferralCode}
              onDismiss={handleDismissAttribution}
            />
          </div>

          <section className="trust-bar-wrap">
            <div className="storefront-shell">
              {/* ── 4. Trust bar ── */}
              <div className="trust-bar" role="list" aria-label="Trust signals">
                <div className="trust-bar-item" role="listitem">
                  <span className="trust-icon" aria-hidden="true">01</span>
                  <span>Official NCAA licensing</span>
                </div>
                <div className="trust-bar-divider" aria-hidden="true" />
                <div className="trust-bar-item" role="listitem">
                  <span className="trust-icon" aria-hidden="true">02</span>
                  <span>Military-approved collections</span>
                </div>
                <div className="trust-bar-divider" aria-hidden="true" />
                <div className="trust-bar-item" role="listitem">
                  <span className="trust-icon" aria-hidden="true">03</span>
                  <span>Serialized hologram verification</span>
                </div>
                <div className="trust-bar-divider" aria-hidden="true" />
                <div className="trust-bar-item" role="listitem">
                  <span className="trust-icon" aria-hidden="true">04</span>
                  <span>Gift-ready packaging system</span>
                </div>
              </div>
            </div>
          </section>

          <div className="storefront-shell">
            {error ? (
              <section className="catalog-error-banner" role="alert" aria-live="polite">
                <p className="catalog-error-banner__eyebrow">Catalog Error</p>
                <p className="catalog-error-banner__message">
                  We couldn&apos;t load the storefront catalog right now.
                </p>
                <p className="catalog-error-banner__detail">{error.message}</p>
              </section>
            ) : null}
          </div>

          <div className="storefront-shell">
            {/* ── 6. Brand positioning ── */}
            <section className="gift-positioning" aria-label="West Point graduation feature">
              <div className="gift-positioning-inner">
                <p className="gift-positioning-eyebrow">West Point Graduation Feature</p>
                <h2 className="gift-positioning-title">
                  Give them their flowers,<br />
                  with an Army vase made to keep.
                </h2>
                <p className="gift-positioning-legacy">May 20-23 at West Point Graduation.</p>
                <p className="gift-positioning-occasions">Cadets · Families · Graduates · Legacy Gifts</p>
                <p className="gift-positioning-body">
                  We&apos;re featuring the Army vase as a graduation-week gift: a cleaner, more meaningful way
                  to celebrate service, sacrifice, and the people who got them there. Built for flowers today,
                  and display long after the ceremony is over.
                </p>
                <div className="hero-actions">
                  <Link to={ARMY_VASE_CHECKOUT_PATH} className="gtg-btn gtg-btn--gold gtg-btn--lg hero-primary-cta">
                    Order Today
                  </Link>
                </div>
              </div>
              <div className="gift-positioning-floral" aria-hidden="true">
                <div className="gift-positioning-spotlight">
                  <div className="gift-positioning-spotlight-art">
                    <img src={ARMY_VASE_FEATURE_ART} alt="" loading="lazy" decoding="async" />
                  </div>
                  <div className="gift-positioning-spotlight-copy">
                    <span className="gift-positioning-spotlight-label">Army Graduation Spotlight</span>
                    <strong>Giving them their flowers, the right way.</strong>
                    <span>Built for West Point families looking for an Army gift that feels personal, elevated, and lasting.</span>
                    <Link to={ARMY_VASE_CHECKOUT_PATH} className="gtg-btn gtg-btn--gold hero-primary-cta">
                      Order Today
                    </Link>
                  </div>
                </div>
              </div>
            </section>
          </div>

        {/* ── 7. Sport selector ── */}
        <div className="home-band-inner">
          <section id="sport-selector" className="sport-selector-section" aria-label="Shop by sport">
            <div className="sport-selector-head">
              <Heading as="h2" className="sport-selector-title">Who Are You Shopping For?</Heading>
              <p className="sport-selector-subtitle">Choose a sport to narrow the gift search.</p>
            </div>

            <div className="sport-selector-grid" role="group" aria-label="Filter products by sport">
              <button
                type="button"
                className={`sport-card ${sportFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => handleSportSelect('ALL')}
                aria-pressed={sportFilter === 'ALL'}
              >
                <div className="sport-card-art all-sports" aria-hidden="true">
                    <img src={gameTimeGiftLogo} alt="" loading="lazy" decoding="async" />
                </div>
                <span className="sport-card-label">All Sports</span>
              </button>

              {SPORT_SELECTOR_ITEMS.map(({ sport, label, art }) => (
                <button
                  key={sport}
                  type="button"
                  className={`sport-card ${sportFilter === sport ? 'active' : ''}`}
                  onClick={() => handleSportSelect(sport)}
                  aria-pressed={sportFilter === sport}
                >
                  <div className="sport-card-art" aria-hidden="true">
                    <img src={art} alt="" loading="lazy" decoding="async" />
                  </div>
                  <span className="sport-card-label">{label}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* ── 9. Designed-to-pair editorial ── */}
        <div className="home-band-inner">
          <Suspense fallback={<DeferredSectionFallback minHeight={260} />}>
            <DesignedToPairSection />
          </Suspense>
        </div>

        {/* ── 11. Founder story ── */}
        <div className="home-band-inner">
          <Suspense fallback={<DeferredSectionFallback minHeight={260} />}>
            <FounderSection />
          </Suspense>
        </div>

        <Suspense fallback={<DeferredSectionFallback minHeight={180} />}>
          <StorefrontFooter />
        </Suspense>
        </div>
      </main>
    </>
  )
}
