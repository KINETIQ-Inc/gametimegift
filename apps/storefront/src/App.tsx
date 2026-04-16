/**
 * App — router root for the Game Time Gift storefront.
 *
 * Route map:
 *   /                        → HomePage    (hero + catalog + gift flow)
 *   /shop                    → ShopPage    (filter bar + full product grid)
 *   /authenticity            → AuthenticityPage (licensing + serial verification hub)
 *   /product/:sku/:slug      → ProductPage (product detail + related products)
 *   /checkout                → CheckoutPage (Stripe checkout flow — standalone)
 *   /consultant              → ConsultantPage (consultant program landing)
 *   * (catch-all)            → redirect to /
 *
 * StorefrontProvider wraps all routes, supplying shared state:
 *   products, cart, filters, and referral attribution.
 *
 * CheckoutPage is still rendered inside StorefrontProvider so it can reuse
 * the shared catalog and referral state, while remaining the only checkout UI.
 */

import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { StorefrontProvider } from './contexts/StorefrontContext'
import { HomePage } from './pages/HomePage'
import { ShopPage } from './pages/ShopPage'
import { AuthenticityPage } from './pages/AuthenticityPage'
import { ProductPage } from './pages/ProductPage'
import { ConsultantPage } from './pages/ConsultantPage'
import { InfoPage } from './pages/InfoPage'

const CheckoutPage = lazy(async () =>
  import('./pages/CheckoutPage').then((m) => ({ default: m.CheckoutPage })),
)

export default function App() {
  return (
    <StorefrontProvider>
      <div style={{ width: '100%' }}>
        <Routes>
          {/* Main storefront pages — share context */}
          <Route path="/" element={<HomePage />} />
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/authenticity" element={<AuthenticityPage />} />
          <Route path="/product/:sku/:slug" element={<ProductPage />} />
          <Route path="/consultant" element={<ConsultantPage />} />
          <Route path="/:slug" element={<InfoPage />} />

          {/* Checkout — dedicated single entry point, lazy-loaded */}
          <Route
            path="/checkout"
            element={
              <Suspense fallback={null}>
                <CheckoutPage />
              </Suspense>
            }
          />

          {/* Catch-all → home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </StorefrontProvider>
  )
}
