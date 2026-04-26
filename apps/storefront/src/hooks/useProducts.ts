import { useEffect, useState } from 'react'
import { listProductsWithFallback } from '@gtg/api'

export interface StorefrontProduct {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: string
  retail_price_cents: number
  created_at: string
  updated_at: string
}

export function useProducts() {
  const [products, setProducts] = useState<StorefrontProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadProducts(): Promise<void> {
      setLoading(true)
      setError(null)

      try {
        const result = await listProductsWithFallback({ limit: 120, offset: 0 })
        if (!cancelled && result.products.length > 0) {
          setProducts(result.products)
          return
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Failed to load products'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadProducts()

    return () => {
      cancelled = true
    }
  }, [])

  return { products, loading, error }
}
