/**
 * CheckoutPage — dedicated /checkout page.
 *
 * URL: /checkout?sku=FLA-FTBL[&ref=GTG-SELLER1]
 *
 * PAGE STATES:
 *   loading    — fetching product from API
 *   not-found  — no ?sku= param, or product not in catalog
 *   form       — customer filling in name / email / optional codes
 *   submitting — API calls in flight ("Processing…")
 *   confirmed  — Stripe returned ?gtg_checkout=success ("Order Confirmed")
 *   cancelled  — Stripe returned ?gtg_checkout=cancelled ("Payment not completed")
 *   api-error  — createOrder threw ("Payment failed — retry")
 *
 * SUCCESS RETURN:
 *   buildCheckoutPageSuccessUrl() points Stripe back to this same page
 *   with ?gtg_checkout=success preserved. The page re-mounts, detects the
 *   param, loads the stored session, and renders OrderConfirmation.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  createOrder,
  ensureAnonymousSession,
  resolveConsultantCode,
  toUserMessage,
} from '@gtg/api'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import {
  clearCheckoutIdempotencyKey,
  clearCheckoutReturn,
  clearCheckoutSession,
  loadOrCreateCheckoutIdempotencyKey,
  loadCheckoutSession,
  parseCheckoutReturn,
  storeCheckoutSession,
  type StoredCheckoutSession,
} from '../checkout-flow'
import {
  CHECKOUT_SUBMITTING,
  ERR_CHECKOUT_FAILED,
  ERR_CHECKOUT_RETRY,
  ERR_EMAIL_INVALID,
  ERR_NAME_REQUIRED,
  errConsultantNotFound,
} from '../checkout-copy'
import { getFeaturedProductArt } from '../config/featured-product-art'
import { getProductSlug, shortenProductName } from '../product-routing'
import { trackStorefrontEvent } from '../analytics'
import { captureReferralAttribution, clearReferralAttribution } from '../referral-attribution'
import { useStorefront } from '../contexts/StorefrontContext'
import gameTimeGiftLogo from '../assets/game_time_gift.png'

const OrderConfirmation = lazy(async () =>
  import('../components/checkout/OrderConfirmation').then((mod) => ({
    default: mod.OrderConfirmation,
  })),
)

const CHECKOUT_REQUEST_TIMEOUT_MS = 10_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(cents / 100)
}

function buildCheckoutPageSuccessUrl(sku: string): string {
  const url = new URL(`${window.location.origin}/checkout`)
  url.searchParams.set('sku', sku)
  url.searchParams.set('gtg_checkout', 'success')
  return url.toString()
}

function buildCheckoutPageCancelUrl(sku: string, slug: string): string {
  const url = new URL(`${window.location.origin}/checkout`)
  url.searchParams.set('sku', sku)
  url.searchParams.set('gtg_checkout', 'cancelled')
  url.hash = `product/${encodeURIComponent(sku)}/${slug}`
  return url.toString()
}

// ─── Types ────────────────────────────────────────────────────────────────────

type PagePhase =
  | 'loading'
  | 'not-found'
  | 'form'
  | 'submitting'
  | 'confirmed'
  | 'cancelled'
  | 'api-error'

type ErrorKind = 'validation' | 'api'

// ─── Component ────────────────────────────────────────────────────────────────

export function CheckoutPage() {
  const params = new URLSearchParams(window.location.search)
  const skuParam = params.get('sku')?.trim().toUpperCase() ?? null
  const bundleParam = params.get('bundle')?.trim().toLowerCase() ?? null
  const flowersParam = params.get('flowers')?.trim().toLowerCase() ?? null
  const {
    products,
    loading: catalogLoading,
    activeReferralCode: contextReferralCode,
    checkoutEnabled,
  } = useStorefront()

  const [phase, setPhase] = useState<PagePhase>('loading')
  const [confirmedSession, setConfirmedSession] = useState<StoredCheckoutSession | null>(null)
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null)

  // Form fields
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [consultantCode, setConsultantCode] = useState('')
  const [discountCode, setDiscountCode] = useState('')
  const [codesOpen, setCodesOpen] = useState(false)

  // Error state
  const [errorMessage, setErrorMessage] = useState('')
  const [errorKind, setErrorKind] = useState<ErrorKind>('validation')

  const nameRef = useRef<HTMLInputElement>(null)
  const checkoutAttemptKeyRef = useRef<string | null>(null)
  const submitLockRef = useRef(false)
  const product = products.find((candidate) => candidate.sku === skuParam) ?? null
  const isSubmitting = phase === 'submitting'

  // On mount: detect Stripe return, or load product
  useEffect(() => {
    const ret = parseCheckoutReturn()

    if (ret.kind === 'success') {
      const session = loadCheckoutSession()
      setConfirmedSession(session)
      setConfirmedOrderId(ret.orderId ?? session?.orderId ?? null)
      clearCheckoutReturn()
      setPhase('confirmed')
      return
    }

    if (ret.kind === 'cancelled') {
      clearCheckoutReturn()
      setPhase('cancelled')
      // Still load the product so the customer can retry
    }

    if (!skuParam) {
      setPhase('not-found')
      return
    }

    if (catalogLoading) {
      setPhase('loading')
      return
    }

    if (!product) {
      setPhase('not-found')
      return
    }

    const resolvedReferralCode = contextReferralCode ?? captureReferralAttribution()
    if (resolvedReferralCode) {
      setConsultantCode((current) => current || resolvedReferralCode)
      setCodesOpen(true)
    }

    if (ret.kind === 'cancelled') {
      setPhase('cancelled')
    } else {
      setPhase('form')
    }

    trackStorefrontEvent('checkout_page_viewed', {
      sku: product.sku,
      licenseBody: product.license_body,
    })
  }, [catalogLoading, contextReferralCode, product, skuParam])

  // Focus name field when form becomes active
  useEffect(() => {
    if (phase === 'form') {
      nameRef.current?.focus()
    }
  }, [phase])

  useEffect(() => {
    if (!isSubmitting) {
      return
    }

    const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    const clickHandler = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const interactiveTarget = target.closest('a, button')
      if (!interactiveTarget) {
        return
      }

      if (
        interactiveTarget instanceof HTMLButtonElement &&
        interactiveTarget.type === 'submit'
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
    }

    const popStateHandler = () => {
      window.history.pushState(null, '', window.location.href)
    }

    window.history.pushState(null, '', window.location.href)
    window.addEventListener('beforeunload', beforeUnloadHandler)
    window.addEventListener('popstate', popStateHandler)
    document.addEventListener('click', clickHandler, true)

    return () => {
      window.removeEventListener('beforeunload', beforeUnloadHandler)
      window.removeEventListener('popstate', popStateHandler)
      document.removeEventListener('click', clickHandler, true)
    }
  }, [isSubmitting])

  function clearError(): void {
    if (phase === 'api-error') {
      setPhase('form')
      setErrorMessage('')
      setErrorKind('validation')
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!product || !checkoutEnabled || submitLockRef.current) return

    submitLockRef.current = true

    const trimmedName = customerName.trim()
    const trimmedEmail = customerEmail.trim().toLowerCase()
    const trimmedCode = consultantCode.trim().toUpperCase()
    const trimmedDiscount = discountCode.trim().toUpperCase()

    // Client-side validation
    if (!trimmedName) {
      submitLockRef.current = false
      setErrorMessage(ERR_NAME_REQUIRED)
      setErrorKind('validation')
      setPhase('api-error')
      return
    }
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      submitLockRef.current = false
      setErrorMessage(ERR_EMAIL_INVALID)
      setErrorKind('validation')
      setPhase('api-error')
      return
    }

    setPhase('submitting')
    trackStorefrontEvent('checkout_submitted', {
      sku: product.sku,
      licenseBody: product.license_body,
      hasConsultantCode: trimmedCode.length > 0,
      hasDiscountCode: trimmedDiscount.length > 0,
    })

    try {
      await ensureAnonymousSession()

      let consultantId: string | undefined

      if (trimmedCode) {
        const resolved = await resolveConsultantCode(trimmedCode)

        if (!resolved) {
          submitLockRef.current = false
          trackStorefrontEvent('checkout_error', {
            sku: product.sku,
            reason: 'consultant_code_not_found',
          })
          setErrorMessage(errConsultantNotFound(trimmedCode))
          setErrorKind('validation')
          setPhase('api-error')
          return
        }

        consultantId = resolved.consultant_id
      }

      const successUrl = buildCheckoutPageSuccessUrl(product.sku)
      const cancelUrl = buildCheckoutPageCancelUrl(product.sku, getProductSlug(product))
      const attemptKey = checkoutAttemptKeyRef.current ?? loadOrCreateCheckoutIdempotencyKey(product.sku)
      checkoutAttemptKeyRef.current = attemptKey

      const checkoutAbortController = new AbortController()
      const checkoutTimeout = window.setTimeout(() => {
        checkoutAbortController.abort()
      }, CHECKOUT_REQUEST_TIMEOUT_MS)

      let result
      try {
        result = await createOrder({
          productId: product.id,
          quantity: 1,
          customerName: trimmedName,
          customerEmail: trimmedEmail,
          successUrl,
          cancelUrl,
          idempotencyKey: attemptKey,
          ...(consultantId ? { consultantId } : {}),
          ...(trimmedDiscount ? { discountCode: trimmedDiscount } : {}),
        }, {
          signal: checkoutAbortController.signal,
        })
      } finally {
        window.clearTimeout(checkoutTimeout)
      }

      storeCheckoutSession(result, trimmedName, trimmedEmail, product.retail_price_cents)
      trackStorefrontEvent('checkout_redirected', {
        sku: product.sku,
        orderId: result.order_id,
        orderNumber: result.order_number,
      })

      window.location.href = result.session_url
    } catch (error) {
      submitLockRef.current = false
      const message = toUserMessage(error, ERR_CHECKOUT_FAILED)
      trackStorefrontEvent('checkout_error', {
        sku: product.sku,
        reason: 'request_failed',
        message,
      })
      setErrorMessage(message)
      setErrorKind('api')
      setPhase('api-error')
    }
  }

  function handleConfirmationVerify(serialNumber: string): void {
    trackStorefrontEvent('confirmation_verify_clicked', {
      hasSerialNumber: serialNumber.length > 0,
    })
    clearCheckoutSession()
    clearCheckoutIdempotencyKey()
    clearReferralAttribution()
    window.location.href = `/authenticity${serialNumber ? `?serial=${encodeURIComponent(serialNumber)}` : ''}`
  }

  function handleConfirmationContinue(): void {
    trackStorefrontEvent('confirmation_continue_clicked')
    clearCheckoutSession()
    clearCheckoutIdempotencyKey()
    clearReferralAttribution()
    window.location.href = '/'
  }

  const art = product ? getFeaturedProductArt(product) : null
  const orderTotal = product ? product.retail_price_cents : 0

  const bundleLabel =
    bundleParam === 'flowers'
      ? 'Vase + Flowers'
      : bundleParam === 'humidor'
        ? 'Vase + Cigar Humidor'
        : bundleParam === 'vase'
          ? 'Vase Only'
          : null

  const flowersLabel =
    flowersParam === 'roses-carnations'
      ? 'Roses + Carnations'
      : flowersParam === 'roses'
        ? 'Roses Only'
        : null

  // ── Confirmed state — full OrderConfirmation ──────────────────────────────
  if (phase === 'confirmed') {
    return (
      <Suspense fallback={null}>
        <OrderConfirmation
          orderId={confirmedOrderId}
          session={confirmedSession}
          onVerify={handleConfirmationVerify}
          onContinue={handleConfirmationContinue}
        />
      </Suspense>
    )
  }

  return (
    <div className="checkout-page" id="main-content">
      <div className="container">

      {/* ── Nav ── */}
      <div className="checkout-page-nav">
        <a
          href={isSubmitting ? undefined : '/'}
          className="checkout-page-logo"
          aria-label="Game Time Gift — back to store"
          aria-disabled={isSubmitting}
          onClick={(event) => {
            if (isSubmitting) {
              event.preventDefault()
            }
          }}
        >
          <img src={gameTimeGiftLogo} alt="" aria-hidden="true" decoding="async" />
          <span>GAME TIME GIFT</span>
        </a>
        <span className="checkout-page-step">Secure Checkout</span>
      </div>

      <div className="checkout-page-body">

        {/* ── Loading ── */}
        {phase === 'loading' ? (
          <div className="checkout-page-loading" role="status" aria-live="polite">
            <div className="checkout-page-loading-card">
              <span className="checkout-spinner checkout-spinner--lg" aria-hidden="true" />
              <p className="checkout-page-loading-title">Preparing your secure checkout…</p>
              <p className="checkout-page-loading-copy">
                We&apos;re loading your order summary and payment details now.
              </p>
            </div>
          </div>
        ) : null}

        {/* ── Not found ── */}
        {phase === 'not-found' ? (
          <div className="checkout-page-not-found">
            <Heading as="h1">Product not found</Heading>
            <p>This product is no longer available or the link may be incorrect.</p>
            <Button type="button" variant="gold" size="lg" onClick={() => { window.location.href = '/' }}>
              Browse available gifts
            </Button>
          </div>
        ) : null}

        {/* ── Cancelled notice + retry ── */}
        {phase === 'cancelled' && product ? (
          <div className="checkout-page-cancelled">
            <AlertBanner kind="error">
              Payment not completed. You can try again below.
            </AlertBanner>
          </div>
        ) : null}

        {/* ── Product + form ── */}
        {(phase === 'form' || phase === 'submitting' || phase === 'api-error' || phase === 'cancelled') && product ? (
          <div className="checkout-page-layout">

            {/* ── Product summary ── */}
            <aside className="checkout-page-product">
              <div className="checkout-page-summary-head">
                <p className="checkout-page-summary-eyebrow">Order Summary</p>
                <h2 className="checkout-page-summary-title">A premium gift, almost reserved.</h2>
              </div>

              <div className="checkout-page-product-art-frame">
                {art ? (
                  <img
                    className="checkout-page-product-art"
                    src={art.assetPath}
                    alt={product.name}
                    style={{ padding: art.artPadding }}
                    decoding="async"
                  />
                ) : null}
              </div>

              <div className="checkout-page-product-info">
                <p className="checkout-page-product-label">You&apos;re purchasing</p>
                <p className="checkout-page-product-name">{shortenProductName(product.name)}</p>
                <p className="checkout-page-product-meta">
                  {product.license_body === 'ARMY' ? 'Military Licensed' : 'Officially Licensed'}
                  {' · '}Hologram Verified
                </p>
              </div>

              {bundleLabel ? (
                <div className="checkout-page-bundle">
                  <p className="checkout-page-bundle-label">Selected bundle</p>
                  <p className="checkout-page-bundle-value">
                    {bundleLabel}
                    {flowersLabel ? ` — ${flowersLabel}` : ''}
                  </p>
                  <p className="checkout-page-bundle-note">
                    Bundle selections are confirmed during checkout.
                  </p>
                </div>
              ) : null}

              <div className="checkout-page-order-lines" aria-label="Order totals">
                <div className="checkout-page-order-line">
                  <span>Item subtotal</span>
                  <strong>{formatCents(product.retail_price_cents)}</strong>
                </div>
                <div className="checkout-page-order-line">
                  <span>Shipping</span>
                  <strong>Included</strong>
                </div>
                <div className="checkout-page-order-line checkout-page-order-line--total">
                  <span>Order total</span>
                  <strong>{formatCents(orderTotal)}</strong>
                </div>
              </div>

              <div className="checkout-page-trust">
                <span>Gift-ready presentation</span>
                <span>Stripe-secured payment</span>
                <span>30-day guarantee</span>
              </div>
            </aside>

            {/* ── Form ── */}
            <main className="checkout-page-form-col">
              <div className="checkout-page-form-head">
                <p className="checkout-page-form-eyebrow">Customer Information</p>
                <Heading as="h1" className="checkout-page-title">Complete your order with confidence.</Heading>
                <p className="checkout-page-form-copy">
                  Enter your details below and we&apos;ll send your receipt and order confirmation right away.
                </p>
              </div>

              {phase === 'api-error' ? (
                <AlertBanner kind="error" actionLabel="Dismiss" onAction={clearError}>
                  {errorMessage}
                  {errorKind === 'api' ? (
                    <span className="checkout-error-retry">{ERR_CHECKOUT_RETRY}</span>
                  ) : null}
                </AlertBanner>
              ) : null}

              <form
                className="checkout-form"
                onSubmit={(event) => { void handleSubmit(event) }}
                noValidate
              >
                <div className="checkout-field">
                  <label htmlFor="cp-name">Full name</label>
                  <input
                    id="cp-name"
                    ref={nameRef}
                    type="text"
                    value={customerName}
                    onChange={(event) => { setCustomerName(event.target.value); clearError() }}
                    placeholder="Jane Smith"
                    autoComplete="name"
                    required
                    disabled={isSubmitting}
                  />
                </div>

                <div className="checkout-field">
                  <label htmlFor="cp-email">Email address</label>
                  <input
                    id="cp-email"
                    type="email"
                    value={customerEmail}
                    onChange={(event) => { setCustomerEmail(event.target.value); clearError() }}
                    placeholder="jane@example.com"
                    autoComplete="email"
                    required
                    disabled={isSubmitting}
                  />
                  <p className="checkout-field-hint">Order confirmation and receipt will be sent here.</p>
                </div>

                {/* ── Optional codes — progressive disclosure ── */}
                <div className="checkout-codes-section">
                  <button
                    type="button"
                    className="checkout-codes-toggle"
                    onClick={() => setCodesOpen((open) => !open)}
                    disabled={isSubmitting}
                    aria-expanded={codesOpen}
                  >
                    <span>Have a consultant or discount code?</span>
                    <span className="checkout-codes-toggle-icon" aria-hidden="true">
                      {codesOpen ? '−' : '+'}
                    </span>
                  </button>

                  {codesOpen ? (
                    <div className="checkout-field-group">
                      <div className="checkout-field">
                        <label htmlFor="cp-consultant">Consultant code</label>
                        <input
                          id="cp-consultant"
                          type="text"
                          value={consultantCode}
                          onChange={(event) => { setConsultantCode(event.target.value); clearError() }}
                          placeholder="GTG-XXXXX"
                          autoComplete="off"
                          disabled={isSubmitting}
                        />
                      </div>

                      <div className="checkout-field">
                        <label htmlFor="cp-discount">Discount code</label>
                        <input
                          id="cp-discount"
                          type="text"
                          value={discountCode}
                          onChange={(event) => { setDiscountCode(event.target.value); clearError() }}
                          placeholder="SUMMER25"
                          autoComplete="off"
                          disabled={isSubmitting}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                <section className="checkout-payment-section" aria-label="Payment step">
                  <div className="checkout-payment-head">
                    <p className="checkout-payment-eyebrow">Payment</p>
                    <h2 className="checkout-payment-title">Review and continue to secure payment.</h2>
                    <p className="checkout-payment-copy">
                      You&apos;ll be redirected to Stripe to complete your purchase with encrypted payment processing.
                    </p>
                  </div>

                  <div className="checkout-payment-summary">
                    <div className="checkout-payment-line">
                      <span>Today&apos;s total</span>
                      <strong>{formatCents(product.retail_price_cents)}</strong>
                    </div>
                    <div className="checkout-payment-line">
                      <span>Shipping</span>
                      <strong>Included</strong>
                    </div>
                  </div>

                  <div className="checkout-payment-trust" role="list" aria-label="Payment assurances">
                    <span role="listitem">Stripe-secured checkout</span>
                    <span role="listitem">Encrypted payment processing</span>
                    <span role="listitem">Receipt sent instantly by email</span>
                  </div>

                  <Button
                    type="submit"
                    variant="gold"
                    size="lg"
                    className="checkout-submit"
                    disabled={isSubmitting || !checkoutEnabled}
                    aria-busy={isSubmitting}
                  >
                    {isSubmitting ? (
                      <>
                        <span className="checkout-spinner" aria-hidden="true" />
                        {CHECKOUT_SUBMITTING}
                      </>
                    ) : (
                      `Continue to Payment — ${formatCents(product.retail_price_cents)}`
                    )}
                  </Button>
                </section>

                <p className="checkout-stripe-note">
                  Payment processed by Stripe. Your card details are never stored by Game Time Gift.
                </p>
              </form>
            </main>
          </div>
        ) : null}
      </div>
      </div>
    </div>
  )
}
