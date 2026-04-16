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
  useDeferredValue,
  useEffect,
  useState,
} from 'react'
import { Badge, Button, Heading } from '@gtg/ui'
import { type ProductListItem } from '@gtg/api'
import { formatUsdCents } from '@gtg/utils'
import { trackStorefrontEvent } from '../analytics'
import { useStorefront } from '../contexts/StorefrontContext'
import { ConsultantAttributionBanner } from '../components/referral/ConsultantAttributionBanner'
import { MegaNav } from '../components/mega-nav/MegaNav'
import { SiteNav } from '../components/nav/SiteNav'
import {
  filterProducts,
  getProductPath,
  getSportFromProduct,
  shortenProductName,
  type LicenseFilter,
  type SportFilter,
} from '../product-routing'
import type { NavTabId } from '../config/mega-nav'
import { getFeaturedProductArt } from '../config/featured-product-art'
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
import floralArrangement from '../assets/floral_arrangement.png'
import { ProductCard as UiProductCard } from '@gtg/ui'

const FeaturedCarousel = lazy(async () =>
  import('../components/FeaturedCarousel').then((m) => ({ default: m.FeaturedCarousel })),
)
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

// ── Helpers ───────────────────────────────────────────────────

function getSportArtForProduct(product: ProductListItem): string | null {
  const featuredArt = getFeaturedProductArt(product)
  if (featuredArt) return featuredArt.assetPath

  switch (getSportFromProduct(product)) {
    case 'FOOTBALL': return footballArt
    case 'BASKETBALL': return basketballArt
    case 'SOCCER': return soccerArt
    case 'BASEBALL': return baseballArt
    case 'HOCKEY': return hockeyArt
    default: return null
  }
}

function sportLabel(filter: SportFilter): string {
  if (filter === 'ALL') return 'Gift Collection'
  return `Signature ${filter.charAt(0)}${filter.slice(1).toLowerCase()} Gifts`
}

function scrollToId(id: string): void {
  const target = document.getElementById(id)
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// ── Sub-components ────────────────────────────────────────────

function DeferredSectionFallback({ minHeight = 160 }: { minHeight?: number }) {
  return <div style={{ minHeight }} aria-hidden="true" />
}

function GiftFlowPanel({
  product,
  onAddGift,
}: {
  product: ProductListItem | null
  onAddGift: (product: ProductListItem, giftDetails: { recipient: string; occasion: string; note: string }) => void
}) {
  const [recipient, setRecipient] = useState('')
  const [occasion, setOccasion] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    setRecipient('')
    setOccasion('')
    setNote('')
  }, [product?.sku])

  if (!product) return null

  return (
    <section className="gift-flow-panel" aria-label="Gift flow">
      <div className="gift-flow-intro">
        <p className="gift-flow-eyebrow">Gift Builder</p>
        <Heading as="h2">Add the gift details.</Heading>
        <p>Personalize the order before checkout with who it&apos;s for, the occasion, and a note worth keeping.</p>

        <div className="gift-flow-summary">
          <span className="gift-flow-summary-label">Selected piece</span>
          <strong>{shortenProductName(product.name)}</strong>
          <span>{formatUsdCents(product.retail_price_cents)} · Officially licensed · Verified</span>
        </div>

        <div className="gift-flow-steps" aria-label="Gift detail steps">
          <span>Recipient</span>
          <span>Occasion</span>
          <span>Gift note</span>
        </div>
      </div>

      <form
        className="gift-flow-form"
        onSubmit={(event) => {
          event.preventDefault()
          onAddGift(product, {
            recipient: recipient.trim(),
            occasion: occasion.trim(),
            note: note.trim(),
          })
        }}
      >
        <label>
          Recipient
          <input
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="Dad, coach, alum, veteran..."
          />
        </label>
        <label>
          Occasion
          <input
            value={occasion}
            onChange={(event) => setOccasion(event.target.value)}
            placeholder="Father's Day, graduation, retirement..."
          />
        </label>
        <label>
          Gift note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why this piece fits them"
            rows={3}
          />
        </label>
        <Button type="submit" variant="gold" size="lg">
          Save Gift Details
        </Button>
      </form>
    </section>
  )
}

// ── HomePage ──────────────────────────────────────────────────

export function HomePage() {
  const {
    products,
    loading,
    licenseFilter,
    sportFilter,
    setLicenseFilter,
    setSportFilter,
    cartMessage,
    addProductToCart,
    activeReferralCode,
    handleDismissAttribution,
  } = useStorefront()

  const filteredProducts = filterProducts(
    products,
    licenseFilter as LicenseFilter,
    sportFilter as SportFilter,
  )
  const deferredProducts = useDeferredValue(filteredProducts)

  function handleSportSelect(sport: SportFilter) {
    startTransition(() => {
      setSportFilter(sport)
    })
    scrollToId('catalog')
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
    scrollToId('catalog')
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
                        Shop by Team
                      </a>
                      <a href="/authenticity" className="hero-secondary-cta">
                        Authenticity
                      </a>
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
            {/* ── 6. Brand positioning ── */}
            <section className="gift-positioning" aria-label="About Game Time Gift">
              <div className="gift-positioning-inner">
                <p className="gift-positioning-eyebrow">Brand Positioning</p>
                <h2 className="gift-positioning-title">
                  Premium sports gifts,<br />
                  built to live on display.
                </h2>
                <p className="gift-positioning-legacy">Not merch. A piece they keep.</p>
                <p className="gift-positioning-occasions">Alumni · Hosts · Collectors · Families</p>
                <p className="gift-positioning-body">
                  Built for meaningful gifting and long-term display, every piece combines licensed credibility,
                  verified authenticity, and a more elevated presentation than typical sports retail.
                </p>
              </div>
              <div className="gift-positioning-floral" aria-hidden="true">
                <div className="gift-positioning-spotlight">
                  <div className="gift-positioning-spotlight-art">
                    <img src={floralArrangement} alt="" loading="lazy" decoding="async" />
                  </div>
                  <div className="gift-positioning-spotlight-copy">
                    <span className="gift-positioning-spotlight-label">Signature Gift Object</span>
                    <strong>Display-ready, not disposable.</strong>
                    <span>Made for shelves, offices, entry tables, and gifting moments that matter.</span>
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

        {/* ── 8. Catalog — featured carousel + product grid ── */}
        <div className="home-band-inner">
          <section id="catalog" className="catalog-surface">
            <div className="catalog-head">
              <Heading as="h2" display={false}>{sportLabel(sportFilter as SportFilter)}</Heading>
              <span>{loading ? 'Loading...' : `${deferredProducts.length} items`}</span>
            </div>

            <Suspense fallback={<DeferredSectionFallback minHeight={360} />}>
              <FeaturedCarousel
                products={deferredProducts}
                loading={loading}
                formatCurrency={formatUsdCents}
                getProductHref={getProductPath}
              />
            </Suspense>

            {deferredProducts.length > 0 ? (
              <div className="product-grid">
                {deferredProducts.map((product) => (
                  <UiProductCard
                    key={product.id}
                    name={shortenProductName(product.name)}
                    priceCents={product.retail_price_cents}
                    imageUrl={getSportArtForProduct(product) ?? gameTimeGiftLogo}
                    imageAlt={product.name}
                    imageWrapClassName="product-card-visual"
                    imageClassName={
                      getSportArtForProduct(product)
                        ? 'product-card-sport-art'
                        : 'product-card-sport-art product-card-logo-fallback'
                    }
                    actionLabel="Add to Cart"
                    href={getProductPath(product)}
                    ariaLabel={`${shortenProductName(product.name)} — ${formatUsdCents(product.retail_price_cents)}`}
                    onClick={() =>
                      trackStorefrontEvent('product_selected', {
                        sku: product.sku,
                        licenseBody: product.license_body,
                        priceCents: product.retail_price_cents,
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <section className="product-types" aria-label="Shop by product type">
                {[
                  {
                    title: 'Football Gift Sets',
                    description:
                      'Curated football-themed gifts built for game rooms, offices, and milestone moments.',
                    highlight: 'Best Seller',
                  },
                  {
                    title: 'Campus Collectibles',
                    description:
                      'Display-ready keepsakes that bring licensed team pride into shelves, mantels, and desks.',
                    highlight: 'Licensed',
                  },
                  {
                    title: 'Alumni Gifts',
                    description:
                      'Polished graduation, legacy, and donor-style pieces designed for lifelong school pride.',
                    highlight: 'Legacy',
                  },
                  {
                    title: 'Home & Bar Gifts',
                    description: 'Vases, frames, and conversation pieces for the fan who entertains.',
                    highlight: 'Home',
                  },
                ].map((card) => (
                  <article key={card.title} className="product-type-card">
                    <Badge variant="occasion">{card.highlight}</Badge>
                    <Heading as="h3" display={false}>{card.title}</Heading>
                    <p>{card.description}</p>
                    <a href="#catalog" className="product-type-link">Explore</a>
                  </article>
                ))}
              </section>
            )}
          </section>
        </div>

        {/* ── 9. Gift flow (personalization form) ── */}
        <div className="home-band-inner">
          <section id="gift-flow" className="gift-flow-section">
            <GiftFlowPanel
              product={deferredProducts[0] ?? null}
              onAddGift={(product, giftDetails) => addProductToCart(product, 'gift', giftDetails)}
            />
          </section>
        </div>

        {/* ── 10. Designed-to-pair editorial ── */}
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
