/**
 * StorefrontContext — shared data and interaction layer for all storefront pages.
 *
 * Provides:
 *   - Product catalog (fetched once, shared across all pages)
 *   - Cart state (persisted to localStorage)
 *   - Catalog filters (licenseFilter, sportFilter)
 *   - Route-based checkout guardrails (no modal checkout state)
 *   - Referral attribution (activeReferralCode)
 *
 * Usage:
 *   Wrap the router root with <StorefrontProvider>.
 *   In any page or component: const ctx = useStorefront()
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  listProducts,
  type ProductListItem,
} from '@gtg/api'
import { getEnv } from '@gtg/config'
import { DEV_MOCK_STOREFRONT_PRODUCTS } from '../config/mock-catalog'
import {
  captureReferralAttribution,
  clearReferralAttribution,
} from '../referral-attribution'
import { trackStorefrontEvent, initStorefrontPerformanceTracking } from '../analytics'
import { shortenProductName } from '../product-routing'
import { StorefrontContext } from './storefront-context'
import { useStorefrontSession } from './useStorefrontSession'

// ── Cart types ──────────────────────────────────────────────

export type CartIntent = 'cart' | 'gift'

export interface GiftIntentDetails {
  recipient: string
  occasion: string
  note: string
}

export interface CartEntry {
  sku: string
  name: string
  quantity: number
  unitPriceCents: number
  intent: CartIntent
  giftDetails?: GiftIntentDetails
}

// ── Filter types ────────────────────────────────────────────

export type { LicenseFilter, SportFilter } from '../product-routing'

// ── Storage ─────────────────────────────────────────────────

const CART_STORAGE_KEY = 'gtg-storefront-cart-v1'

function loadStoredCart(): CartEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = window.localStorage.getItem(CART_STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    const sanitized = parsed.filter((entry): entry is CartEntry =>
      typeof entry?.sku === 'string' &&
      typeof entry?.name === 'string' &&
      typeof entry?.quantity === 'number' &&
      typeof entry?.unitPriceCents === 'number' &&
      (entry?.intent === 'cart' || entry?.intent === 'gift') &&
      (entry?.giftDetails === undefined ||
        (typeof entry.giftDetails?.recipient === 'string' &&
          typeof entry.giftDetails?.occasion === 'string' &&
          typeof entry.giftDetails?.note === 'string')),
    )

    const firstEntry = sanitized[0]
    if (!firstEntry) return []

    // Serialized collectibles currently ship one per checkout.
    return [{ ...firstEntry, quantity: 1 }]
  } catch {
    return []
  }
}

function saveStoredCart(cart: CartEntry[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
}

// ── Context shape ────────────────────────────────────────────

export interface StorefrontContextValue {
  // Product catalog
  products: ProductListItem[]
  loading: boolean
  error: Error | null
  sessionReady: boolean
  checkoutEnabled: boolean

  // Catalog filters
  licenseFilter: string
  sportFilter: string
  setLicenseFilter: (f: string) => void
  setSportFilter: (f: string) => void

  // Cart
  cart: CartEntry[]
  cartCount: number
  cartMessage: string | null
  addProductToCart: (
    product: ProductListItem,
    intent: CartIntent,
    giftDetails?: GiftIntentDetails,
    quantity?: number,
  ) => void
  removeFromCart: (sku: string, intent: CartIntent) => void
  updateCartQuantity: (sku: string, intent: CartIntent, quantity: number) => void

  // Referral attribution
  activeReferralCode: string | null
  handleDismissAttribution: () => void

  // Verify panel deep-link support
  verifySerialFromConfirmation: string | null
  clearVerifySerialFromConfirmation: () => void
}

// ── Context ──────────────────────────────────────────────────

// ── Provider ─────────────────────────────────────────────────

export function StorefrontProvider({ children }: { children: ReactNode }) {
  const { appEnv } = getEnv()
  const { sessionReady } = useStorefrontSession()

  // ── Catalog ──
  const [products, setProducts] = useState<ProductListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // ── Filters ──
  const [licenseFilter, setLicenseFilter] = useState<string>('ALL')
  const [sportFilter, setSportFilter] = useState<string>('ALL')

  // ── Cart ──
  const [cart, setCart] = useState<CartEntry[]>(() => loadStoredCart())
  const [cartMessage, setCartMessage] = useState<string | null>(null)

  // ── Referral ──
  const [activeReferralCode, setActiveReferralCode] = useState<string | null>(
    () => captureReferralAttribution(),
  )

  const [verifySerialFromConfirmation, setVerifySerialFromConfirmation] = useState<string | null>(null)

  const hasTrackedInit = useRef(false)

  // ── Fetch catalog ──────────────────────────────────────────
  useEffect(() => {
    if (!hasTrackedInit.current) {
      hasTrackedInit.current = true
      trackStorefrontEvent('storefront_loaded', { routeKind: 'init' })
      initStorefrontPerformanceTracking()
    }

    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      try {
        const result = await listProducts({ limit: 120, offset: 0 })
        if (result.products.length > 0) {
          setProducts(result.products)
        } else if (appEnv !== 'production') {
          setProducts(DEV_MOCK_STOREFRONT_PRODUCTS)
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to load products'))
        if (appEnv !== 'production') {
          setProducts(DEV_MOCK_STOREFRONT_PRODUCTS)
        }
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [])

  // ── Persist cart ──────────────────────────────────────────
  useEffect(() => {
    saveStoredCart(cart)
  }, [cart])

  // ── Auto-clear cart flash ─────────────────────────────────
  useEffect(() => {
    if (!cartMessage) return
    const timer = window.setTimeout(() => setCartMessage(null), 2600)
    return () => window.clearTimeout(timer)
  }, [cartMessage])

  // ── Handlers ──────────────────────────────────────────────

  const addProductToCart = useCallback(
    (
      product: ProductListItem,
      intent: CartIntent,
      giftDetails?: GiftIntentDetails,
      quantity = 1,
    ) => {
      const normalizedQuantity = Number.isFinite(quantity) ? Math.max(1, Math.floor(quantity)) : 1

      setCart((current) => {
        const existingEntry = current[0]
        const nextEntry: CartEntry = {
          sku: product.sku,
          name: shortenProductName(product.name),
          quantity: 1,
          unitPriceCents: product.retail_price_cents,
          intent,
          giftDetails,
        }

        if (
          existingEntry &&
          existingEntry.sku === product.sku &&
          existingEntry.intent === intent
        ) {
          return [{ ...nextEntry, giftDetails: giftDetails ?? existingEntry.giftDetails }]
        }

        return [nextEntry]
      })

      setCartMessage(
        normalizedQuantity > 1
          ? `${shortenProductName(product.name)} added. Orders currently support one collectible per checkout.`
          : intent === 'gift'
            ? `${shortenProductName(product.name)} saved to the gift flow.`
            : `${shortenProductName(product.name)} added to cart.`,
      )

      trackStorefrontEvent('cart_item_added', {
        sku: product.sku,
        intent,
        priceCents: product.retail_price_cents,
      })
    },
    [],
  )

  const removeFromCart = useCallback((sku: string, intent: CartIntent) => {
    setCart((current) => current.filter((e) => !(e.sku === sku && e.intent === intent)))
  }, [])

  const updateCartQuantity = useCallback((sku: string, intent: CartIntent, quantity: number) => {
    if (quantity < 1) return
    setCart((current) =>
      current.map((e) => e.sku === sku && e.intent === intent ? { ...e, quantity: 1 } : e),
    )
  }, [])

  const handleDismissAttribution = useCallback(() => {
    clearReferralAttribution()
    setActiveReferralCode(null)
  }, [])

  const clearVerifySerialFromConfirmation = useCallback(() => {
    setVerifySerialFromConfirmation(null)
  }, [])

  const cartCount = cart.reduce((sum, e) => sum + e.quantity, 0)

  const value: StorefrontContextValue = {
    products,
    loading,
    error,
    sessionReady,
    checkoutEnabled: true,
    licenseFilter,
    sportFilter,
    setLicenseFilter,
    setSportFilter,
    cart,
    cartCount,
    cartMessage,
    addProductToCart,
    removeFromCart,
    updateCartQuantity,
    activeReferralCode,
    handleDismissAttribution,
    verifySerialFromConfirmation,
    clearVerifySerialFromConfirmation,
  }

  return (
    <StorefrontContext.Provider value={value}>
      {children}
    </StorefrontContext.Provider>
  )
}
