/**
 * ShopPage — rendered at "/shop"
 *
 * Sections (in order):
 *   1. SiteNav           — persistent top nav (light mode)
 *   2. ShopHeader        — page title + item count + active filter summary
 *   3. FilterBar         — sport pill tabs + license toggle
 *   4. ProductGrid       — full product grid (all matching products)
 *   5. EmptyState        — shown when no products match filters
 *   6. StorefrontFooter  — shared footer
 *
 * This page is catalog-focused: no hero, no gift flow form, no verify panel.
 * Those live on the homepage. ShopPage is for browsing and discovery.
 *
 * URL parameters (read on mount, reflected in filters):
 *   ?sport=FOOTBALL|BASKETBALL|SOCCER|BASEBALL|HOCKEY
 *   ?license=CLC|ARMY
 */

import { lazy, startTransition, Suspense, useDeferredValue, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button, Heading } from '@gtg/ui'
import { formatUsdCents } from '@gtg/utils'
import { type ProductListItem } from '@gtg/api'
import { trackStorefrontEvent } from '../analytics'
import { useStorefront } from '../contexts/StorefrontContext'
import { SiteNav } from '../components/nav/SiteNav'
import {
  filterProducts,
  getProductPath,
  getSportFromProduct,
  shortenProductName,
  type LicenseFilter,
  type SportFilter,
} from '../product-routing'
import { getFeaturedProductArt as getArt } from '../config/featured-product-art'
import { ProductCard as UiProductCard } from '@gtg/ui'
import footballArt from '../assets/football.png'
import basketballArt from '../assets/basketball.png'
import soccerArt from '../assets/soccer.png'
import baseballArt from '../assets/baseball.png'
import hockeyArt from '../assets/hockey.png'
import gameTimeGiftLogo from '../assets/game_time_gift.png'

const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)

// ── Sport tabs config ─────────────────────────────────────────

const SPORT_TABS = [
  { value: 'ALL', label: 'All Sports' },
  { value: 'FOOTBALL', label: 'Football' },
  { value: 'BASKETBALL', label: 'Basketball' },
  { value: 'SOCCER', label: 'Soccer' },
  { value: 'BASEBALL', label: 'Baseball' },
  { value: 'HOCKEY', label: 'Hockey' },
] as const

const LICENSE_TABS = [
  { value: 'ALL', label: 'All Collections' },
  { value: 'CLC', label: 'NCAA' },
  { value: 'ARMY', label: 'Military' },
] as const

const GIFTING_PROMISES = [
  'Curated football inventory',
  'Officially licensed',
  'Verified and display-ready',
] as const

// ── Helpers ───────────────────────────────────────────────────

function getSportArtForProduct(product: ProductListItem): string | null {
  const featuredArt = getArt(product)
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

function DeferredFallback({ minHeight = 160 }: { minHeight?: number }) {
  return <div style={{ minHeight }} aria-hidden="true" />
}

// ── ShopPage ──────────────────────────────────────────────────

export function ShopPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    products,
    loading,
    error,
    licenseFilter,
    sportFilter,
    setLicenseFilter,
    setSportFilter,
  } = useStorefront()
  const gridRef = useRef<HTMLElement | null>(null)

  // Read URL params on mount to pre-set filters
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const sport = params.get('sport')?.toUpperCase()
    const license = params.get('license')?.toUpperCase()

    const validSports: string[] = ['FOOTBALL', 'BASKETBALL', 'SOCCER', 'BASEBALL', 'HOCKEY']
    const validLicenses: string[] = ['CLC', 'ARMY']

    if (sport && validSports.includes(sport)) {
      setSportFilter(sport)
    }
    if (license && validLicenses.includes(license)) {
      setLicenseFilter(license)
    }
  }, [location.search, setSportFilter, setLicenseFilter])

  const filteredProducts = filterProducts(
    products,
    licenseFilter as LicenseFilter,
    sportFilter as SportFilter,
  )
  const deferredProducts = useDeferredValue(filteredProducts)
  const activeSportLabel = SPORT_TABS.find((tab) => tab.value === sportFilter)?.label ?? 'All Sports'
  const activeLicenseLabel = LICENSE_TABS.find((tab) => tab.value === licenseFilter)?.label ?? 'All Collections'
  const hasActiveFilters = sportFilter !== 'ALL' || licenseFilter !== 'ALL'

  function syncShopQuery(nextSport: string, nextLicense: string): void {
    const params = new URLSearchParams()
    if (nextSport !== 'ALL') {
      params.set('sport', nextSport)
    }
    if (nextLicense !== 'ALL') {
      params.set('license', nextLicense)
    }

    const nextSearch = params.toString()
    navigate(
      {
        pathname: '/shop',
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    )
  }

  function scrollToInventoryWall(): void {
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function handleSportSelect(sport: string) {
    startTransition(() => {
      setSportFilter(sport)
    })
    syncShopQuery(sport, licenseFilter)
    scrollToInventoryWall()
    trackStorefrontEvent('catalog_filter_changed', { sportFilter: sport, licenseFilter })
  }

  function handleLicenseSelect(license: string) {
    startTransition(() => {
      setLicenseFilter(license)
    })
    syncShopQuery(sportFilter, license)
    scrollToInventoryWall()
    trackStorefrontEvent('catalog_filter_changed', { sportFilter, licenseFilter: license })
  }

  return (
    <>
      <main id="main-content" className="shop-page">
        <div className="container">
        {/* ── 1. Navigation ── */}
        <SiteNav mode="light" />

        {/* ── 2. Page header ── */}
        <header className="shop-header">
          <div className="shop-header__shell">
            <div className="shop-header__copy">
              <p className="shop-header__eyebrow">Shop the Collection</p>
              <Heading as="h1" display={false}>A quieter, sharper way to browse the inventory.</Heading>
              <p className="shop-header__subtitle">
                Built like a premium buying floor for comparing pieces, refining options, and choosing the right format.
              </p>

              <div className="shop-header__status-row" aria-label="Collection status">
                <div className="shop-header__status-card">
                  <span className="shop-header__status-label">Collection View</span>
                  <strong className="shop-header__status-value">{activeSportLabel}</strong>
                  <span className="shop-header__status-meta">{activeLicenseLabel}</span>
                </div>
                <div className="shop-header__status-card">
                  <span className="shop-header__status-label">Inventory</span>
                  <strong className="shop-header__status-value">
                    {loading ? 'Loading' : `${deferredProducts.length}`}
                  </strong>
                  <span className="shop-header__status-meta">
                    {loading ? 'pieces loading' : `piece${deferredProducts.length === 1 ? '' : 's'} available`}
                  </span>
                </div>
              </div>

              <div className="shop-header__promises" role="list" aria-label="Shopping benefits">
                {GIFTING_PROMISES.map((promise) => (
                  <span key={promise} role="listitem" className="shop-header__promise">
                    {promise}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </header>

        {/* ── 3. Filter bar ── */}
        <section className="shop-filter-bar" aria-label="Filter products">
          <div className="shop-filter-bar__shell">
            <div className="shop-filter-bar__intro">
              <p className="shop-filter-bar__label">Refine the collection</p>
              <p className="shop-filter-bar__hint">Filter fast, compare cleanly, and move straight into purchase.</p>
            </div>

            {/* Sport tabs */}
            <div
              className="shop-filter-group"
              role="group"
              aria-label="Filter by sport"
            >
              {SPORT_TABS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`shop-filter-tab ${sportFilter === value ? 'shop-filter-tab--active' : ''}`}
                  onClick={() => handleSportSelect(value)}
                  aria-pressed={sportFilter === value}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* License toggle */}
            <div
              className="shop-filter-group shop-filter-group--license"
              role="group"
              aria-label="Filter by license"
            >
              {LICENSE_TABS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`shop-filter-tab ${licenseFilter === value ? 'shop-filter-tab--active' : ''}`}
                  onClick={() => handleLicenseSelect(value)}
                  aria-pressed={licenseFilter === value}
                >
                  {label}
                </button>
              ))}
            </div>

            {hasActiveFilters ? (
              <div className="shop-filter-bar__active" aria-live="polite">
                <span className="shop-filter-pill">Sport: {activeSportLabel}</span>
                <span className="shop-filter-pill">Collection: {activeLicenseLabel}</span>
                <button
                  type="button"
                  className="shop-filter-clear"
                  onClick={() => {
                    startTransition(() => {
                      setSportFilter('ALL')
                      setLicenseFilter('ALL')
                    })
                    syncShopQuery('ALL', 'ALL')
                    scrollToInventoryWall()
                  }}
                >
                  Reset
                </button>
              </div>
            ) : null}
          </div>
        </section>

        {/* ── 4. Product grid ── */}
        <main ref={gridRef} className="shop-grid-area">
          {loading ? (
            <div className="shop-grid-loading" aria-label="Loading products" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="shop-grid-skeleton" aria-hidden="true" />
              ))}
            </div>
          ) : deferredProducts.length > 0 ? (
            <div className="shop-grid-head">
              <div>
                <p className="shop-grid-head__eyebrow">Inventory Wall</p>
                <h2 className="shop-grid-head__title">Browse the collection</h2>
              </div>
              <p className="shop-grid-head__body">
                Compare the available pieces, review the presentation, and choose the format that fits the moment best.
              </p>
            </div>
          ) : null}

          {loading ? null : deferredProducts.length > 0 ? (
            <div className="product-grid shop-product-grid">
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
                  details={
                    <div className="product-card-details">
                      <span className="product-card-kicker">
                        {product.license_body === 'ARMY' ? 'Legacy-worthy gift' : 'Collector-grade gift'}
                      </span>
                    </div>
                  }
                  actionLabel="View Product"
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
          ) : error ? (
            /* ── 5a. Error state ── */
            <section className="shop-empty-state" aria-label="Catalog unavailable">
              <Heading as="h2" display={false}>Unable to load the catalog</Heading>
              <p>There was a problem fetching products. Please try again in a moment.</p>
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </section>
          ) : (
            /* ── 5b. Empty state ── */
            <section className="shop-empty-state" aria-label="No results">
              <Heading as="h2" display={false}>No gifts match these filters</Heading>
              <p>Try removing a filter or browsing all sports.</p>
              <Button
                variant="primary"
                onClick={() => {
                  startTransition(() => {
                    setSportFilter('ALL')
                    setLicenseFilter('ALL')
                  })
                  syncShopQuery('ALL', 'ALL')
                  scrollToInventoryWall()
                }}
              >
                Show all gifts
              </Button>
            </section>
          )}
        </main>

        {/* ── 6. Footer ── */}
        <Suspense fallback={<DeferredFallback minHeight={180} />}>
          <StorefrontFooter />
        </Suspense>
        </div>
      </main>
    </>
  )
}
