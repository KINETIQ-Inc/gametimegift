import { Button } from '@gtg/ui'
import { findAppRouteProduct } from '../../_lib/mock-storefront'
import { AppActionLink, AppRouteSection, AppStatePanel, appCardStyle, parseAppPageState } from '../../_lib/route-ui'

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams?: Promise<{ state?: string }>
}) {
  const { slug } = await params
  const routeState = parseAppPageState((await searchParams)?.state)
  const product = findAppRouteProduct(slug)

  if (!product) {
    return (
      <main>
        <div style={{ display: 'grid', gap: 18 }}>
          <AppStatePanel
            kind="error"
            title="Error state"
            message={`No mock product exists for the slug "${slug}" yet.`}
          />
          <AppRouteSection
            eyebrow="Product Route"
            title="Product not found"
            description="Choose another item from the shop and try again."
          >
            <AppActionLink href="/shop" label="Back to Shop" tone="navy" />
          </AppRouteSection>
        </div>
      </main>
    )
  }

  const activeState = routeState ?? 'success'
  const stateMessageByKind = {
    loading: 'Loading product details for this item…',
    empty: 'This product exists, but details have not been prepared yet.',
    error: `The product route hit an error while loading "${product.name}".`,
    success: 'Product details loaded successfully and the order path is ready.',
  } as const

  return (
    <main>
      <section
        style={{
          ...appCardStyle(),
          maxWidth: 920,
          margin: '0 auto',
        }}
      >
        {activeState === 'success' ? (
          <>
            <div
              style={{
                minHeight: 420,
                marginBottom: 28,
                borderRadius: 24,
                background: 'linear-gradient(180deg, #f6f8fc, #e8eef8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              <img
                src={product.imageSrc}
                alt={product.name}
                style={{
                  width: '72%',
                  maxWidth: 420,
                  objectFit: 'contain',
                }}
              />
            </div>

            <p style={{ margin: 0, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#92600a', fontWeight: 800 }}>
              Product Route
            </p>
            <h2 style={{ margin: '10px 0 12px', fontSize: 42 }}>{product.name}</h2>
            <p style={{ margin: '0 0 14px', fontSize: 30, fontWeight: 800, color: '#031b52' }}>
              {product.price}
            </p>
            <p style={{ margin: 0, maxWidth: 640, lineHeight: 1.7 }}>{product.summary}</p>

            <form action="/checkout" style={{ marginTop: 24 }}>
              <Button type="submit" variant="gold" size="lg">
                Start Your Order
              </Button>
            </form>
          </>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <AppStatePanel
            kind={activeState}
            title={`${activeState.slice(0, 1).toUpperCase()}${activeState.slice(1)} state`}
            message={stateMessageByKind[activeState]}
          />
        </div>
      </section>
    </main>
  )
}
