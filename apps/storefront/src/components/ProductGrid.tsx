import { Heading } from '@gtg/ui'
import { formatUsdCents } from '@gtg/utils'
import { useProducts } from '../hooks/useProducts'

export function ProductGrid() {
  const { products, loading, error } = useProducts()

  if (loading) {
    return <p>Loading...</p>
  }

  if (error) {
    return (
      <div role="alert" className="product-grid-live-error">
        <p>We couldn&apos;t load products right now.</p>
        <p>{error.message}</p>
      </div>
    )
  }

  if (products.length === 0) {
    return <p>No products</p>
  }

  return (
    <section className="product-grid-live" aria-label="Live Supabase products">
      <div className="product-grid-live__head">
        <p className="product-grid-live__eyebrow">Live Catalog</p>
        <Heading as="h2" display={false}>Fresh from Supabase</Heading>
      </div>

      <div className="product-grid-live__list">
        {products.map((product) => (
          <article key={product.id} className="product-grid-live__card">
            <h3 className="product-grid-live__name">{product.name}</h3>
            <p className="product-grid-live__price">{formatUsdCents(product.retail_price_cents)}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
