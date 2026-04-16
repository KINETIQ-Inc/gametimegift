import type { ProductListItem } from '@gtg/api'

export function buildCheckoutPath(
  product: ProductListItem,
  referralCode?: string | null,
  options?: {
    bundle?: 'vase' | 'flowers' | 'humidor'
    flowerOption?: 'roses' | 'roses-carnations'
  },
): string {
  const params = new URLSearchParams()
  params.set('sku', product.sku)

  const trimmedReferralCode = referralCode?.trim().toUpperCase()
  if (trimmedReferralCode) {
    params.set('ref', trimmedReferralCode)
  }

  if (options?.bundle) {
    params.set('bundle', options.bundle)
  }

  if (options?.flowerOption) {
    params.set('flowers', options.flowerOption)
  }

  return `/checkout?${params.toString()}`
}
