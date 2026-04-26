import { lazy, Suspense } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatUsdCents } from '@gtg/utils'
import { useStorefront } from '../contexts/StorefrontContext'
import { SiteNav } from '../components/nav/SiteNav'

const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)

export function CartPage() {
  const navigate = useNavigate()
  const { cart, removeFromCart, updateCartQuantity } = useStorefront()

  const subtotal = cart.reduce((sum, e) => sum + e.unitPriceCents * e.quantity, 0)
  const firstSku = cart[0]?.sku

  return (
    <main id="main-content" className="cart-page">
      <div className="container">
        <SiteNav mode="light" />

        <div className="cart-page__shell">
          <div className="cart-page__header">
            <h1 className="cart-page__title">Your Cart</h1>
            {cart.length > 0 ? (
              <Link to="/shop" className="cart-page__continue">Continue shopping</Link>
            ) : null}
          </div>

          {cart.length === 0 ? (
            <div className="cart-page__empty">
              <p className="cart-page__empty-msg">Your cart is empty.</p>
              <Link to="/shop" className="gtg-btn gtg-btn--primary">Browse gifts</Link>
            </div>
          ) : (
            <div className="cart-page__layout">

              {/* ── Item list ── */}
              <div className="cart-page__items">
                {cart.map((entry) => (
                  <div key={`${entry.sku}-${entry.intent}`} className="cart-page__item">
                    <div className="cart-page__item-info">
                      <p className="cart-page__item-name">{entry.name}</p>
                      <p className="cart-page__item-price">{formatUsdCents(entry.unitPriceCents)}</p>
                    </div>

                    <div className="cart-page__item-actions">
                      <div className="cart-qty-stepper" role="group" aria-label={`Quantity for ${entry.name}`}>
                        <button
                          type="button"
                          className="cart-qty-stepper__btn"
                          aria-label="Decrease quantity"
                          onClick={() => {
                            if (entry.quantity === 1) {
                              removeFromCart(entry.sku, entry.intent)
                            } else {
                              updateCartQuantity(entry.sku, entry.intent, entry.quantity - 1)
                            }
                          }}
                        >−</button>
                        <span className="cart-qty-stepper__count">{entry.quantity}</span>
                        <button
                          type="button"
                          className="cart-qty-stepper__btn"
                          aria-label="Increase quantity"
                          onClick={() => updateCartQuantity(entry.sku, entry.intent, entry.quantity + 1)}
                        >+</button>
                      </div>

                      <button
                        type="button"
                        className="cart-page__remove"
                        onClick={() => removeFromCart(entry.sku, entry.intent)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Order summary ── */}
              <div className="cart-page__summary">
                <div className="cart-page__summary-row">
                  <span>Subtotal</span>
                  <strong>{formatUsdCents(subtotal)}</strong>
                </div>
                <div className="cart-page__summary-row">
                  <span>Shipping</span>
                  <strong>Included</strong>
                </div>
                <div className="cart-page__summary-row cart-page__summary-row--total">
                  <span>Order total</span>
                  <strong>{formatUsdCents(subtotal)}</strong>
                </div>

                <button
                  type="button"
                  className="cart-page__checkout-btn"
                  onClick={() => firstSku && navigate(`/checkout?sku=${firstSku}`)}
                >
                  Proceed to Checkout
                </button>

                <p className="cart-page__secure-note">
                  Stripe-secured · SSL encrypted · Gift-ready presentation
                </p>
              </div>
            </div>
          )}
        </div>

        <Suspense fallback={<div style={{ minHeight: 180 }} />}>
          <StorefrontFooter />
        </Suspense>
      </div>
    </main>
  )
}
