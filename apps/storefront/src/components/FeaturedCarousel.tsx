import { useEffect, useState, type CSSProperties } from 'react'
import type { ProductListItem } from '@gtg/api'
import { Heading } from '@gtg/ui'
import { trackStorefrontEvent } from '../analytics'
import {
  FEATURED_SHOWCASE_ITEMS,
  getFeaturedProductArt,
  orderFeaturedProducts,
  type FeaturedShowcaseItem,
} from '../config/featured-product-art'

interface FeaturedCarouselProps {
  products: ProductListItem[]
  loading: boolean
  formatCurrency: (cents: number) => string
  getProductHref?: (product: ProductListItem) => string
}

type FeaturedSlideItem =
  | (ProductListItem & { source: 'api' })
  | (FeaturedShowcaseItem & { source: 'showcase' })

function shortenProductName(name: string): string {
  // Remove "University of", "The University of", "United States" prefixes
  // and trailing "University" / "State University" for cleaner card headlines
  return name
    .replace(/^The University of /i, '')
    .replace(/^University of /i, '')
    .replace(/^United States /i, '')
    .replace(/ State University\b/i, ' State')
    .replace(/ University\b/i, '')
    .trim()
}

function summarizeProduct(product: ProductListItem | FeaturedShowcaseItem): string {
  if (product.description && product.description.trim().length > 0) {
    return product.description.trim()
  }

  if (product.license_body === 'CLC') {
    return 'Official collegiate gift piece with display-ready presentation.'
  }

  if (product.license_body === 'ARMY') {
    return 'Military licensed collectible designed for service pride and gifting.'
  }

  return 'Signature Game Time Gift collectible crafted for fans and collectors.'
}

export function FeaturedCarousel({
  products,
  loading,
  formatCurrency,
  getProductHref,
}: FeaturedCarouselProps) {
  const featuredProducts: FeaturedSlideItem[] =
    products.length > 0
      ? orderFeaturedProducts(products).slice(0, 8).map((product) => ({ ...product, source: 'api' as const }))
      : FEATURED_SHOWCASE_ITEMS.map((item) => ({ ...item, source: 'showcase' as const }))
  const [activeIndex, setActiveIndex] = useState(0)
  const [failedArtIds, setFailedArtIds] = useState<string[]>([])

  useEffect(() => {
    setActiveIndex(0)
  }, [products.length])

  useEffect(() => {
    setFailedArtIds([])
  }, [featuredProducts.length])

  if (loading && products.length === 0) {
    return (
      <section className="featured-carousel loading" aria-label="Featured products">
        <div className="featured-carousel-copy">
          <p className="featured-carousel-kicker">Featured Collection</p>
          <Heading as="h2" display={false}>Loading featured gifts...</Heading>
          <p>We&apos;re pulling in the latest catalog highlights now.</p>
        </div>
      </section>
    )
  }

  const activeProduct = featuredProducts[activeIndex]!

  function moveTo(direction: -1 | 1) {
    setActiveIndex((current) => {
      const nextIndex = current + direction
      if (nextIndex < 0) return featuredProducts.length - 1
      if (nextIndex >= featuredProducts.length) return 0
      return nextIndex
    })
  }

  return (
    <section
      className="featured-carousel"
      aria-label="Featured products"
      aria-roledescription="carousel"
    >
      <div className="featured-carousel-track" style={{ transform: `translateX(-${activeIndex * 100}%)` }}>
        {featuredProducts.map((product) => (
          (() => {
            const art = product.source === 'api'
              ? getFeaturedProductArt(product)
              : { assetPath: product.assetPath, artPadding: product.artPadding, keywords: [] }
            const showArt = Boolean(art) && !failedArtIds.includes(product.id)

            return (
              <article
                key={product.id}
                className="featured-slide"
                aria-hidden={product.id !== activeProduct.id}
              >
                <div className="featured-slide-copy">
                  <p className="featured-carousel-kicker">Featured Collection</p>
                  <div className="featured-slide-meta">
                    <span className={`featured-stock ${product.in_stock ? 'in-stock' : 'out-of-stock'}`}>
                      {product.in_stock ? `${product.available_count} available` : 'Currently unavailable'}
                    </span>
                    {product.source === 'showcase' ? (
                      <span className="featured-stock showcase">Showcase</span>
                    ) : null}
                  </div>
                  <Heading as="h2">{shortenProductName(product.name)}</Heading>
                  <p>{summarizeProduct(product)}</p>
                  <p className="featured-hologram-line">Includes hologram certificate of authenticity</p>

                  <div className="featured-slide-actions">
                    <strong className="featured-price">{formatCurrency(product.retail_price_cents)}</strong>
                    <a
                      href={
                        product.source === 'api' && getProductHref
                          ? getProductHref(product)
                          : '#catalog'
                      }
                      className="featured-primary-cta"
                      onClick={() => trackStorefrontEvent('featured_cta_clicked', {
                        sku: product.source === 'api' ? product.sku : product.id,
                        source: product.source,
                        inStock: product.in_stock,
                      })}
                    >
                      Add to Cart
                    </a>
                  </div>
                </div>

                <div className="featured-slide-card" aria-hidden="true">
                  <div
                    className={`featured-card-frame ${showArt ? 'has-art' : 'no-art'}`}
                    style={art && showArt ? ({ '--featured-art-padding': art.artPadding } as CSSProperties) : undefined}
                  >
                    {art && showArt ? (
                      <img
                        src={art.assetPath}
                        alt={product.name}
                        className="featured-product-art"
                        loading="lazy"
                        decoding="async"
                        onError={() => {
                          setFailedArtIds((current) =>
                            current.includes(product.id) ? current : [...current, product.id],
                          )
                        }}
                      />
                    ) : (
                      <span>{product.name}</span>
                    )}
                  </div>
                </div>
              </article>
            )
          })()
        ))}
      </div>

      {featuredProducts.length > 1 ? (
        <>
          <div className="featured-carousel-controls" aria-label="Carousel navigation">
            <button
              type="button"
              className="featured-arrow"
              aria-label="Previous featured product"
              onClick={() => moveTo(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="featured-arrow"
              aria-label="Next featured product"
              onClick={() => moveTo(1)}
            >
              ›
            </button>
          </div>

          <div className="featured-dots" role="tablist" aria-label="Featured product slides">
            {featuredProducts.map((product, index) => (
              <button
                key={product.id}
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                aria-label={`Show featured product ${index + 1}: ${product.name}`}
                className={`featured-dot ${index === activeIndex ? 'active' : ''}`}
                onClick={() => setActiveIndex(index)}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
}
