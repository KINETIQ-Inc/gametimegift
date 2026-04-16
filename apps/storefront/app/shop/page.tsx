import { ProductCard } from '@gtg/ui'
import { APP_ROUTE_PRODUCTS } from '../_lib/mock-storefront'
import { AppRouteGrid, AppRouteSection, AppStatePanel, parseAppPageState } from '../_lib/route-ui'

export default async function ShopPage({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string }>
}) {
  const routeState = parseAppPageState((await searchParams)?.state)
  const activeState = routeState ?? (APP_ROUTE_PRODUCTS.length === 0 ? 'empty' : 'success')
  const stateMessageByKind = {
    loading: 'Loading product cards for the shop grid…',
    empty: 'No products are available in the mock catalog yet.',
    error: 'The shop grid could not be prepared.',
    success: 'Mock catalog products loaded successfully for the shop grid.',
  } as const

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <AppRouteSection
          eyebrow="Shop Route"
          title="Shop Signature Gifts"
          description="This route stands in for the catalog page and links directly into the dynamic product route."
        />
      </div>

      <div style={{ marginBottom: 18 }}>
        <AppStatePanel
          kind={activeState}
          title={`${activeState.slice(0, 1).toUpperCase()}${activeState.slice(1)} state`}
          message={stateMessageByKind[activeState]}
        />
      </div>

      {activeState === 'success' ? (
        <AppRouteGrid>
          {APP_ROUTE_PRODUCTS.map((product) => (
            <ProductCard
              key={product.slug}
              name={product.name}
              sport={product.sport}
              licenseBody={product.license}
              priceCents={Math.round(Number(product.price.replace(/[$,]/g, '')) * 100)}
              imageUrl={product.imageSrc}
              href={`/product/${product.slug}`}
              actionLabel="View Product"
              actionVariant="gold"
              details={<p style={{ margin: 0, lineHeight: 1.55 }}>{product.summary}</p>}
              className="app-route-product-card"
            />
          ))}
        </AppRouteGrid>
      ) : null}
    </main>
  )
}
