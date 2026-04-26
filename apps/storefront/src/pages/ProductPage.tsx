/**
 * ProductPage — rendered at "/product/:sku/:slug"
 *
 * Sections (in order):
 *   1. SiteNav          — persistent top nav (light mode)
 *   2. Breadcrumb       — Home / Shop / Product Name
 *   3. ProductDetail    — media + copy + actions
 *        - Product image (sport art or logo fallback)
 *        - Trust strip (availability, license, hologram)
 *        - Eyebrow (Collector Gift / Legacy Gift)
 *        - Product name (h1)
 *        - Product story
 *        - Availability + price meta
 *        - CTA: "Buy Now" → navigates to dedicated checkout page
 *        - CTA: "Personalize as a Gift" → scrolls to gift flow
 *        - Trust strip and focused commerce actions
 *   4. GiftFlow         — inline personalization form
 *   5. RelatedProducts  — other products in the same sport
 *   6. StorefrontFooter — shared footer
 *
 * Routing: `:sku` drives the product lookup. `:slug` is decorative.
 * Loading state: shows skeleton until product resolves.
 * Not-found state: shown if SKU is invalid.
 *
 */

import { lazy, Suspense, useState, useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { formatUsdCents } from '@gtg/utils'
import { type ProductListItem } from '@gtg/api'
import { trackStorefrontEvent } from '../analytics'
import { useStorefront } from '../contexts/useStorefront'
import { SiteNav } from '../components/nav/SiteNav'
import {
  getSportFromProduct,
  getProductStory,
  shortenProductName,
  filterProducts,
  getProductPath,
  type LicenseFilter,
  type SportFilter,
} from '../product-routing'
import { getFeaturedProductArt } from '../config/featured-product-art'
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
import { buildCheckoutPath } from '../checkout-routing'

type PurchaseBundle = 'vase' | 'flowers' | 'humidor'
type FlowerOption = 'roses' | 'roses-carnations'

interface CheckoutOptions {
  bundle: PurchaseBundle
  flowerOption?: FlowerOption
}

// ── Helpers ───────────────────────────────────────────────────

function getSportArt(product: ProductListItem): string {
  const featuredArt = getFeaturedProductArt(product)
  if (featuredArt) return featuredArt.assetPath

  switch (getSportFromProduct(product)) {
    case 'FOOTBALL': return footballArt
    case 'BASKETBALL': return basketballArt
    case 'SOCCER': return soccerArt
    case 'BASEBALL': return baseballArt
    case 'HOCKEY': return hockeyArt
    default: return gameTimeGiftLogo
  }
}

function scrollToId(id: string): void {
  const target = document.getElementById(id)
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function DeferredFallback({ minHeight = 160 }: { minHeight?: number }) {
  return <div style={{ minHeight }} aria-hidden="true" />
}

function getProductSpecs(product: ProductListItem) {
  const isFootball = getSportFromProduct(product) === 'FOOTBALL'
  const isMilitary = product.license_body === 'ARMY'

  if (isFootball) {
    return {
      details: [
        ['Overall height', '12.75 in'],
        ['Width', '10.75 in at widest point'],
        ['Opening diameter', '2.5 in'],
        ['Interior depth', '~10.25 in'],
        ['Weight', 'Approx. 5 lbs'],
        ['Scale', 'True regulation football proportions'],
      ],
      materials: [
        'Cold-cast polyresin construction',
        'High-gloss lacquer finish',
        'Textured surface modeled after football leather grain',
        'Hand-painted laces, striping, and logo detailing',
        'Integrated pedestal base for stability',
      ],
      included: [
        'Display-ready football vase',
        'Fully sealed waterproof interior',
        'Standard protective retail packaging with foam or molded insert',
      ],
      care: [
        'Hand wash only',
        'Use mild soap and lukewarm water',
        'Dry with a soft cloth',
        'Avoid abrasive cleaners',
        'Indoor use recommended',
      ],
      authenticity: [
        isMilitary ? 'Official military marks and approved collection standards' : 'Official NCAA / CLC licensing',
        'Registered hologram serial verification',
        'School-specific approved colors and marks',
      ],
    }
  }

  return {
    details: [
      ['Availability', `${product.available_count} ready to ship`],
      ['Price', formatUsdCents(product.retail_price_cents)],
    ],
    materials: [
      'Collector-grade licensed display piece',
      'Built for shelf, office, and gifting presentation',
    ],
    included: [
      'Licensed collectible',
      'Protective packaging for shipping and display',
    ],
    care: [
      'Indoor display recommended',
      'Wipe clean with a soft cloth',
    ],
    authenticity: [
      isMilitary ? 'Official military marks' : 'Official NCAA / CLC licensing',
      'Registered serial-backed authenticity process',
    ],
  }
}

// ── Skeleton ─────────────────────────────────────────────────

function ProductDetailSkeleton() {
  return (
    <section
      className="product-detail-shell product-detail-loading"
      aria-label="Loading product details"
    >
      <div className="product-detail-media">
        <div className="skeleton-block" />
        <div className="product-detail-loading-pills">
          <div className="skeleton-pill" />
          <div className="skeleton-pill" />
          <div className="skeleton-pill" />
        </div>
      </div>
      <div className="product-detail-copy">
        <div className="skeleton-eyebrow" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-line medium" />
        <div className="skeleton-card-grid">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      </div>
    </section>
  )
}

// ── Gift flow inline form ─────────────────────────────────────

function InlineGiftForm({
  onAddGift,
}: {
  onAddGift: (giftDetails: { recipient: string; occasion: string; note: string }) => void
}) {
  const [recipient, setRecipient] = useState('')
  const [occasion, setOccasion] = useState('')
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)

  return (
    <section id="gift-flow" className="gift-flow-panel" aria-label="Personalize this gift">
      <div>
        <p className="gift-flow-eyebrow">Gift Builder</p>
        <Heading as="h2">Make it personal before checkout.</Heading>
        <p>Tell us who this is for and why. We&apos;ll carry it through.</p>

        {saved ? (
          <div className="gift-flow-success">
            <AlertBanner kind="success">
              Gift intent saved. This item is now attached to your saved gift flow.
            </AlertBanner>
          </div>
        ) : null}
      </div>

      <form
        className="gift-flow-form"
        onSubmit={(event) => {
          event.preventDefault()
          onAddGift({
            recipient: recipient.trim(),
            occasion: occasion.trim(),
            note: note.trim(),
          })
          setRecipient('')
          setOccasion('')
          setNote('')
          setSaved(true)
        }}
      >
        <label>
          Recipient
          <input
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value)
              if (saved) setSaved(false)
            }}
            placeholder="Dad, coach, alum, veteran..."
          />
        </label>
        <label>
          Occasion
          <input
            value={occasion}
            onChange={(e) => {
              setOccasion(e.target.value)
              if (saved) setSaved(false)
            }}
            placeholder="Father's Day, graduation, retirement..."
          />
        </label>
        <label>
          Gift note
          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              if (saved) setSaved(false)
            }}
            placeholder="Why this piece fits them"
            rows={3}
          />
        </label>
        <Button type="submit" variant="gold" size="lg">
          Save Gift Intent
        </Button>
      </form>
    </section>
  )
}

// ── ProductDetail ─────────────────────────────────────────────

function ProductDetail({
  product,
  onCheckout,
  onAddToCart,
  onGiftFlow,
  cartCount,
  checkoutEnabled,
}: {
  product: ProductListItem
  onCheckout: (options: CheckoutOptions) => void
  onAddToCart: (quantity: number) => void
  onGiftFlow: () => void
  cartCount: number
  checkoutEnabled: boolean
}) {
  const sportArt = getSportArt(product)
  const featuredArt = getFeaturedProductArt(product)
  const productLabel = shortenProductName(product.name)
  const specs = getProductSpecs(product)
  const [bundlePanelOpen, setBundlePanelOpen] = useState(false)
  const [bundle, setBundle] = useState<PurchaseBundle>('vase')
  const [flowerOption, setFlowerOption] = useState<FlowerOption>('roses')
  const bundleOptions: Array<{
    id: PurchaseBundle
    title: string
    price: string
    description: string
  }> = [
    {
      id: 'vase',
      title: 'Vase Only',
      price: '$139.99',
      description: 'The core collectible on its own, ready for display.',
    },
    {
      id: 'flowers',
      title: 'Vase + Flowers',
      price: '$179–$189',
      description: 'Gift-ready presentation with a full floral insert.',
    },
    {
      id: 'humidor',
      title: 'Vase + Cigar Humidor',
      price: '$179.00',
      description: 'Premium display with a removable humidor insert.',
    },
  ]

  const handleBuyNow = () => {
    if (!bundlePanelOpen) {
      setBundlePanelOpen(true)
      requestAnimationFrame(() => scrollToId('purchase-options'))
      return
    }

    onCheckout({
      bundle,
      flowerOption: bundle === 'flowers' ? flowerOption : undefined,
    })
  }

  return (
    <section id="product-detail" className="product-detail-shell" aria-label="Product detail">
      <div className="product-detail-breadcrumbs">
        <Link to="/">Home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/shop">Shop</Link>
        <span aria-hidden="true">/</span>
        <span>{shortenProductName(product.name)}</span>
      </div>

      <div className="product-detail-layout">
        {/* Media */}
        <div className="product-detail-media">
          <div className="product-detail-art-frame">
            <div className="product-detail-art-frame__badge">Collector Edition</div>
            <div className="product-detail-art-aura" aria-hidden="true" />
            <div className="product-detail-art-stage" aria-hidden="true" />
            <img
              src={sportArt}
              alt={productLabel}
              className={`product-detail-art ${featuredArt ? 'product-detail-art--featured' : ''}`}
              style={featuredArt ? { padding: featuredArt.artPadding } : undefined}
              decoding="async"
            />
          </div>
        </div>

        {/* Copy */}
        <div className="product-detail-copy">
          <div className="product-detail-top">
            <div className="product-detail-info">
              <p className="product-detail-eyebrow">
                {product.license_body === 'ARMY' ? 'Legacy Gift' : 'Collector Gift'}
              </p>
              <Heading as="h1">{productLabel}</Heading>
              <p className="product-detail-lead">
                Chosen for the kind of gift moment that deserves permanence, pride, and presentation.
              </p>
              <p className="product-detail-story">{getProductStory(product)}</p>
            </div>

            <div className="product-detail-buy">
              <div className="product-detail-meta">
                <div>
                  <span className="meta-label">Order Limit</span>
                  {product.in_stock ? (
                    <strong>1 collectible per checkout</strong>
                  ) : (
                    <strong>Currently unavailable</strong>
                  )}
                  {product.in_stock ? (
                    <span className="product-detail-meta-note">Ready to ship</span>
                  ) : null}
                </div>
                <div>
                  <span className="meta-label">Price</span>
                  <strong>{formatUsdCents(product.retail_price_cents)}</strong>
                  <span className="product-detail-meta-note">Per collectible</span>
                </div>
              </div>

              <div className="product-detail-cta-card">
                <div className="product-detail-cta-copy">
                  <p className="product-detail-cta-eyebrow">Ready To Gift</p>
                  <h2 className="product-detail-cta-title">Make this the gift they remember.</h2>
                  <p className="product-detail-cta-body">
                    Secure checkout, premium presentation, and a collectible that feels worthy of the occasion.
                  </p>
                </div>

                {product.in_stock ? (
                  <div className="product-detail-actions">
                    <div
                      id="purchase-options"
                      className={`product-detail-bundle ${bundlePanelOpen ? 'product-detail-bundle--open' : ''}`}
                      aria-live="polite"
                    >
                      <div className="product-detail-bundle-head">
                        <p className="product-detail-bundle-eyebrow">Purchase Options</p>
                        <p className="product-detail-bundle-title">Choose how you want it delivered.</p>
                      </div>

                      <div className="product-detail-bundle-grid" role="radiogroup" aria-label="Bundle options">
                        {bundleOptions.map((option) => (
                          <label
                            key={option.id}
                            className={`product-detail-bundle-card ${
                              bundle === option.id ? 'is-selected' : ''
                            }`}
                          >
                            <input
                              type="radio"
                              name="purchase-bundle"
                              value={option.id}
                              checked={bundle === option.id}
                              onChange={() => setBundle(option.id)}
                            />
                            <span className="product-detail-bundle-card__label">{option.title}</span>
                            <span className="product-detail-bundle-card__price">{option.price}</span>
                            <span className="product-detail-bundle-card__desc">{option.description}</span>
                          </label>
                        ))}
                      </div>

                      {bundle === 'flowers' ? (
                        <div className="product-detail-flower-options">
                          <p className="product-detail-flower-title">Select a floral insert</p>
                          <div className="product-detail-flower-grid" role="radiogroup" aria-label="Flower options">
                            <label
                              className={`product-detail-flower-card ${
                                flowerOption === 'roses' ? 'is-selected' : ''
                              }`}
                            >
                              <input
                                type="radio"
                                name="flower-option"
                                value="roses"
                                checked={flowerOption === 'roses'}
                                onChange={() => setFlowerOption('roses')}
                              />
                              <span className="product-detail-flower-card__image">
                                <img
                                  src="/assets/flowers-roses.png"
                                  alt="Roses only bouquet"
                                  loading="lazy"
                                  onError={(event) => {
                                    event.currentTarget.style.display = 'none'
                                  }}
                                />
                              </span>
                              <span className="product-detail-flower-card__label">Roses Only</span>
                            </label>
                            <label
                              className={`product-detail-flower-card ${
                                flowerOption === 'roses-carnations' ? 'is-selected' : ''
                              }`}
                            >
                              <input
                                type="radio"
                                name="flower-option"
                                value="roses-carnations"
                                checked={flowerOption === 'roses-carnations'}
                                onChange={() => setFlowerOption('roses-carnations')}
                              />
                              <span className="product-detail-flower-card__image">
                                <img
                                  src="/assets/flowers-roses-carnations.png"
                                  alt="Roses with carnations bouquet"
                                  loading="lazy"
                                  onError={(event) => {
                                    event.currentTarget.style.display = 'none'
                                  }}
                                />
                              </span>
                              <span className="product-detail-flower-card__label">Roses + Carnations</span>
                            </label>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="product-detail-action-grid">
                      <Button variant="gold" size="lg" onClick={handleBuyNow} disabled={!checkoutEnabled}>
                        {bundlePanelOpen ? 'Continue to Checkout' : 'Buy Now'}
                      </Button>
                      <Button variant="primary" size="lg" onClick={() => onAddToCart(1)}>
                        Add to Cart
                      </Button>
                    </div>
                    <Button variant="ghost" size="md" onClick={onGiftFlow}>
                      Add Gift Details
                    </Button>
                    <div className="product-detail-cart-note" aria-live="polite">
                      {bundlePanelOpen
                        ? `Bundle selected: ${
                            bundle === 'vase'
                              ? 'Vase Only'
                              : bundle === 'flowers'
                                ? `Vase + Flowers${flowerOption === 'roses-carnations' ? ' — Roses + Carnations' : ' — Roses Only'}`
                                : 'Vase + Cigar Humidor'
                          }.`
                        : cartCount > 0
                          ? `${cartCount} item${cartCount === 1 ? '' : 's'} waiting in your cart`
                          : 'Buy now for immediate checkout, or add to cart and keep browsing.'}
                    </div>
                  </div>
                ) : (
                  <p className="product-detail-unavailable">
                    This item is currently out of stock.{' '}
                    <Link to="/shop">Browse available gifts →</Link>
                  </p>
                )}
              </div>
            </div>
          </div>

        </div>

      </div>

      <section className="product-detail-specs" aria-label="Product details and specifications">
        <article className="product-detail-spec-card gtg-card gtg-card--tight">
          <p className="product-detail-spec-card__eyebrow">Product Details</p>
          <Heading as="h2" className="product-detail-spec-card__title">Built like a real gift object.</Heading>
          <dl className="product-detail-spec-list">
            {specs.details.map(([label, value]) => (
              <div key={label} className="product-detail-spec-list__row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </article>

        <article className="product-detail-spec-card gtg-card gtg-card--tight">
          <p className="product-detail-spec-card__eyebrow">Materials & Finish</p>
          <ul className="product-detail-bullet-list">
            {specs.materials.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="product-detail-spec-card gtg-card gtg-card--tight">
          <p className="product-detail-spec-card__eyebrow">What&apos;s Included</p>
          <ul className="product-detail-bullet-list">
            {specs.included.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="product-detail-spec-card gtg-card gtg-card--tight">
          <p className="product-detail-spec-card__eyebrow">Care & Authenticity</p>
          <ul className="product-detail-bullet-list">
            {specs.care.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {specs.authenticity.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>
    </section>
  )
}

// ── ProductPage ───────────────────────────────────────────────

export function ProductPage() {
  const { sku: rawSku } = useParams<{ sku: string; slug: string }>()
  const sku = decodeURIComponent(rawSku ?? '').trim()

  const {
    products,
    loading,
    addProductToCart,
    activeReferralCode,
    cartCount,
    checkoutEnabled,
  } = useStorefront()
  const navigate = useNavigate()

  const product = products.find((p) => p.sku === sku) ?? null

  // Track page view
  useEffect(() => {
    if (product) {
      trackStorefrontEvent('route_viewed', { routeKind: 'product', productSku: product.sku })
    }
  }, [product])

  // ── Scroll to gift flow when CTA clicked ──
  function handleGiftFlow() {
    if (product) {
      trackStorefrontEvent('gift_flow_started', {
        sku: product.sku,
        licenseBody: product.license_body,
        priceCents: product.retail_price_cents,
      })
    }
    scrollToId('gift-flow')
  }

  // ── Related products (same sport, excluding this product) ──
  const sport = product ? getSportFromProduct(product) : null
  const relatedProducts = sport
    ? filterProducts(products, 'ALL' as LicenseFilter, sport as SportFilter)
        .filter((p) => p.sku !== sku)
        .slice(0, 4)
    : []

  return (
    <>
      <main id="main-content" className="product-page">
        <div className="container">
        {/* ── 1. Navigation ── */}
        <SiteNav mode="light" />

        {/* ── 2–3. Product detail ── */}
        {loading ? (
          <ProductDetailSkeleton />
        ) : product ? (
          <ProductDetail
            product={product}
            cartCount={cartCount}
            checkoutEnabled={checkoutEnabled}
            onCheckout={(options) => {
              trackStorefrontEvent('checkout_opened', {
                sku: product.sku,
                licenseBody: product.license_body,
                priceCents: product.retail_price_cents,
                entryPoint: 'product_page',
                bundle: options.bundle,
                flowerOption: options.flowerOption,
              })
              navigate(buildCheckoutPath(product, activeReferralCode, options))
            }}
            onAddToCart={(quantity) => addProductToCart(product, 'cart', undefined, quantity)}
            onGiftFlow={handleGiftFlow}
          />
        ) : (
          /* Not found */
          <section className="product-missing-state">
            <Heading as="h1" display={false}>Product not found</Heading>
            <p>
              The SKU <code>{sku}</code> could not be matched to a product in our catalog.
            </p>
            <Link to="/shop" className="gtg-btn gtg-btn--gold gtg-btn--lg">
              Browse Available Gifts
            </Link>
          </section>
        )}

        {/* ── 4. Gift flow ── */}
        {product ? (
          <section className="gift-flow-section">
            <InlineGiftForm
              onAddGift={(giftDetails) => addProductToCart(product, 'gift', giftDetails)}
            />
          </section>
        ) : null}

        {/* ── 5. Related products ── */}
        {relatedProducts.length > 0 ? (
          <section className="related-products" aria-label="Related gifts">
            <div className="related-products__head">
              <Heading as="h2" display={false}>More gifts you might like</Heading>
            </div>
            <div className="product-grid product-grid--compact">
              {relatedProducts.map((related) => {
                const sportArt = getSportArt(related)
                return (
                  <UiProductCard
                    key={related.id}
                    name={shortenProductName(related.name)}
                    licenseBody={
                      related.license_body === 'ARMY' ? 'Military Licensed' : 'Officially Licensed'
                    }
                    priceCents={related.retail_price_cents}
                    hologramVerified
                    imageUrl={sportArt}
                    imageAlt=""
                    compact
                    href={getProductPath(related)}
                    ariaLabel={`${shortenProductName(related.name)} — ${formatUsdCents(related.retail_price_cents)}`}
                  />
                )
              })}
            </div>
          </section>
        ) : null}

        {/* ── 6. Footer ── */}
        <Suspense fallback={<DeferredFallback minHeight={180} />}>
          <StorefrontFooter />
        </Suspense>
        </div>
      </main>
    </>
  )
}
