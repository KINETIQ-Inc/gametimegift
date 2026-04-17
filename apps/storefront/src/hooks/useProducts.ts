import { useEffect, useState } from 'react'
import { getClient } from '@gtg/api'

type ProductLicenseBody = 'CLC' | 'ARMY' | 'NONE'

export interface StorefrontProduct {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: ProductLicenseBody
  retail_price_cents: number
  created_at: string
  updated_at: string
}

interface ProductRow {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: ProductLicenseBody
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
        const client = getClient()
        const { data, error: queryError } = await client
          .from('products')
          .select('id, sku, name, description, school, license_body, retail_price_cents, created_at, updated_at')
          .eq('active', true)
          .order('created_at', { ascending: false })

        if (queryError) {
          throw queryError
        }

        const nextProducts = (data ?? []) as ProductRow[]

        if (!cancelled) {
          setProducts(nextProducts)
          console.log('[GTG] useProducts fetched products', nextProducts)
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
