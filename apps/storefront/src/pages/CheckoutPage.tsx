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
 *   confirmed  — Stripe payment confirmed ("Order Confirmed")
 *   cancelled  — legacy return state from older Checkout Session flow
 *   api-error  — createOrder threw ("Payment failed — retry")
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  createOrder,
  ensureAnonymousSession,
  getMyCustomerProfile,
  isAuthError,
  resolveConsultantCode,
  signOut,
  toUserMessage,
} from '@gtg/api'
import { getEnv } from '@gtg/config'
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
import { shortenProductName } from '../product-routing'
import { trackStorefrontEvent } from '../analytics'
import { captureReferralAttribution, clearReferralAttribution } from '../referral-attribution'
import { useStorefront } from '../contexts/useStorefront'
import { useStorefrontSession } from '../contexts/useStorefrontSession'
import gameTimeGiftLogo from '../assets/game_time_gift.png'

const OrderConfirmation = lazy(async () =>
  import('../components/checkout/OrderConfirmation').then((mod) => ({
    default: mod.OrderConfirmation,
  })),
)

const CHECKOUT_REQUEST_TIMEOUT_MS = 10_000

async function createOrderWithSessionRecovery(
  input: Parameters<typeof createOrder>[0],
  options: Parameters<typeof createOrder>[1],
) {
  try {
    return await createOrder(input, options)
  } catch (error) {
    if (!isAuthError(error)) {
      throw error
    }

    await signOut()
    await ensureAnonymousSession()
    return createOrder(input, options)
  }
}

interface StripeCardChangeEvent {
  error?: { message?: string }
}

interface StripeCardElement {
  mount: (element: HTMLElement | string) => void
  destroy: () => void
  on: (event: 'change', handler: (event: StripeCardChangeEvent) => void) => void
}

interface StripeElements {
  create: (type: 'card', options?: Record<string, unknown>) => StripeCardElement
}

interface StripeConfirmCardPaymentResult {
  paymentIntent?: {
    id: string
    status: string
  }
  error?: {
    message?: string
  }
}

interface StripeBillingAddress {
  line1?: string
  line2?: string | null
  city?: string
  state?: string
  postal_code?: string
  country?: string
}

interface StripeClient {
  elements: () => StripeElements
  confirmCardPayment: (
    clientSecret: string,
    data: {
      payment_method: {
        card: StripeCardElement
        billing_details: {
          name: string
          email: string
          address?: StripeBillingAddress
        }
      }
    },
  ) => Promise<StripeConfirmCardPaymentResult>
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient
  }
}

let stripeLoaderPromise: Promise<StripeClient> | null = null

async function loadStripeClient(publishableKey: string): Promise<StripeClient> {
  if (window.Stripe) {
    return window.Stripe(publishableKey)
  }

  if (!stripeLoaderPromise) {
    stripeLoaderPromise = new Promise<StripeClient>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-gtg-stripe-js="true"]')
      if (existing) {
        existing.addEventListener('load', () => {
          if (window.Stripe) {
            resolve(window.Stripe(publishableKey))
            return
          }
          reject(new Error('Stripe.js failed to initialize.'))
        }, { once: true })
        existing.addEventListener('error', () => reject(new Error('Stripe.js failed to load.')), { once: true })
        return
      }

      const script = document.createElement('script')
      script.src = 'https://js.stripe.com/v3/'
      script.async = true
      script.dataset.gtgStripeJs = 'true'
      script.onload = () => {
        if (window.Stripe) {
          resolve(window.Stripe(publishableKey))
          return
        }
        reject(new Error('Stripe.js failed to initialize.'))
      }
      script.onerror = () => reject(new Error('Stripe.js failed to load.'))
      document.head.appendChild(script)
    })
  }

  return stripeLoaderPromise
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(cents / 100)
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
  const { stripePublishableKey } = getEnv()
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
  const { isCustomer, currentUserEmail } = useStorefrontSession()

  const [phase, setPhase] = useState<PagePhase>('loading')
  const [confirmedSession, setConfirmedSession] = useState<StoredCheckoutSession | null>(null)
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null)
  const [serverOrderTotalCents, setServerOrderTotalCents] = useState<number | null>(null)

  // Form fields
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [consultantCode, setConsultantCode] = useState('')
  const [discountCode, setDiscountCode] = useState('')
  const [codesOpen, setCodesOpen] = useState(false)

  // Shipping address
  const [shippingLine1, setShippingLine1] = useState('')
  const [shippingLine2, setShippingLine2] = useState('')
  const [shippingCity, setShippingCity] = useState('')
  const [shippingState, setShippingState] = useState('')
  const [shippingZip, setShippingZip] = useState('')

  // Billing address
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true)
  const [billingLine1, setBillingLine1] = useState('')
  const [billingLine2, setBillingLine2] = useState('')
  const [billingCity, setBillingCity] = useState('')
  const [billingState, setBillingState] = useState('')
  const [billingZip, setBillingZip] = useState('')

  // Gift personalization
  const [giftRecipient, setGiftRecipient] = useState('')
  const [giftOccasion, setGiftOccasion] = useState('')
  const [giftNote, setGiftNote] = useState('')

  // Add-ons (flowers are mutually exclusive; humidor is independent)
  type FlowerAddon = 'roses_carnations' | 'roses_only'
  const [flowerAddon, setFlowerAddon] = useState<FlowerAddon | null>(null)
  const [humidorAddon, setHumidorAddon] = useState(false)

  const addonTotalCents =
    (flowerAddon === 'roses_carnations' ? 4500 : 0) +
    (flowerAddon === 'roses_only' ? 3500 : 0) +
    (humidorAddon ? 4000 : 0)

  // Error state
  const [errorMessage, setErrorMessage] = useState('')
  const [errorKind, setErrorKind] = useState<ErrorKind>('validation')
  const [cardErrorMessage, setCardErrorMessage] = useState('')
  const [cardReady, setCardReady] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (currentUserEmail && customerEmail.trim().length === 0) {
      setCustomerEmail(currentUserEmail)
    }
  }, [currentUserEmail, customerEmail])

  useEffect(() => {
    if (!isCustomer) return

    let active = true

    async function hydrateCustomerProfile(): Promise<void> {
      try {
        const profile = await getMyCustomerProfile()
        if (!active || !profile) return

        if (profile.full_name && customerName.trim().length === 0) {
          setCustomerName(profile.full_name)
        }

        if (shippingLine1.trim().length === 0 && profile.default_shipping_address) {
          const address = profile.default_shipping_address as Record<string, unknown>
          setShippingLine1(typeof address.line1 === 'string' ? address.line1 : '')
          setShippingLine2(typeof address.line2 === 'string' ? address.line2 : '')
          setShippingCity(typeof address.city === 'string' ? address.city : '')
          setShippingState(typeof address.state === 'string' ? address.state : '')
          setShippingZip(typeof address.postalCode === 'string' ? address.postalCode : '')
        }
      } catch {
        // Non-blocking: checkout still works if customer profile hydration fails.
      }
    }

    void hydrateCustomerProfile()
    return () => {
      active = false
    }
  }, [isCustomer, customerName, shippingLine1])
  const cardMountRef = useRef<HTMLDivElement>(null)
  const checkoutAttemptKeyRef = useRef<string | null>(null)
  const submitLockRef = useRef(false)
  const stripeClientRef = useRef<StripeClient | null>(null)
  const stripeElementsRef = useRef<StripeElements | null>(null)
  const stripeCardElementRef = useRef<StripeCardElement | null>(null)
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
    if (!cardMountRef.current) return
    if (phase === 'confirmed' || phase === 'not-found' || phase === 'loading' || phase === 'submitting') return

    let cancelled = false

    async function mountCardElement(): Promise<void> {
      try {
        const stripe = await loadStripeClient(stripePublishableKey)
        if (cancelled || !cardMountRef.current) return

        stripeClientRef.current = stripe
        const elements = stripeElementsRef.current ?? stripe.elements()
        stripeElementsRef.current = elements

        if (!stripeCardElementRef.current) {
          const card = elements.create('card', {
            hidePostalCode: true,
            style: {
              base: {
                color: '#142f5f',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '16px',
                '::placeholder': { color: '#6c7894' },
              },
            },
          })
          card.on('change', (event) => {
            setCardErrorMessage(event.error?.message ?? '')
          })
          card.mount(cardMountRef.current)
          stripeCardElementRef.current = card
          setCardReady(true)
        }
      } catch (error) {
        if (!cancelled) {
          setCardErrorMessage(error instanceof Error ? error.message : 'Unable to load secure payment fields.')
          setCardReady(false)
        }
      }
    }

    void mountCardElement()

    return () => {
      cancelled = true
    }
  }, [phase, stripePublishableKey])

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
    setCardErrorMessage('')
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!product || !checkoutEnabled || submitLockRef.current) return

    submitLockRef.current = true

    const trimmedName = customerName.trim()
    const trimmedEmail = customerEmail.trim().toLowerCase()
    const trimmedCode = consultantCode.trim().toUpperCase()
    const trimmedDiscount = discountCode.trim().toUpperCase()

    const trimmedShippingLine1 = shippingLine1.trim()
    const trimmedShippingLine2 = shippingLine2.trim()
    const trimmedShippingCity  = shippingCity.trim()
    const trimmedShippingState = shippingState.trim()
    const trimmedShippingZip   = shippingZip.trim()

    const effectiveBillingLine1  = billingSameAsShipping ? trimmedShippingLine1  : billingLine1.trim()
    const effectiveBillingLine2  = billingSameAsShipping ? trimmedShippingLine2  : billingLine2.trim()
    const effectiveBillingCity   = billingSameAsShipping ? trimmedShippingCity   : billingCity.trim()
    const effectiveBillingState  = billingSameAsShipping ? trimmedShippingState  : billingState.trim()
    const effectiveBillingZip    = billingSameAsShipping ? trimmedShippingZip    : billingZip.trim()

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
    if (!trimmedShippingLine1) {
      submitLockRef.current = false
      setErrorMessage('Shipping street address is required.')
      setErrorKind('validation')
      setPhase('api-error')
      return
    }
    if (!trimmedShippingCity) {
      submitLockRef.current = false
      setErrorMessage('Shipping city is required.')
      setErrorKind('validation')
      setPhase('api-error')
      return
    }
    if (!trimmedShippingState) {
      submitLockRef.current = false
      setErrorMessage('Shipping state is required.')
      setErrorKind('validation')
      setPhase('api-error')
      return
    }
    if (!trimmedShippingZip) {
      submitLockRef.current = false
      setErrorMessage('Shipping ZIP code is required.')
      setErrorKind('validation')
      setPhase('api-error')
      return
    }
    if (!billingSameAsShipping) {
      if (!billingLine1.trim()) {
        submitLockRef.current = false
        setErrorMessage('Billing street address is required.')
        setErrorKind('validation')
        setPhase('api-error')
        return
      }
      if (!billingCity.trim()) {
        submitLockRef.current = false
        setErrorMessage('Billing city is required.')
        setErrorKind('validation')
        setPhase('api-error')
        return
      }
      if (!billingState.trim()) {
        submitLockRef.current = false
        setErrorMessage('Billing state is required.')
        setErrorKind('validation')
        setPhase('api-error')
        return
      }
      if (!billingZip.trim()) {
        submitLockRef.current = false
        setErrorMessage('Billing ZIP code is required.')
        setErrorKind('validation')
        setPhase('api-error')
        return
      }
    }

    setPhase('submitting')
    trackStorefrontEvent('checkout_submitted', {
      sku: product.sku,
      licenseBody: product.license_body,
      hasConsultantCode: trimmedCode.length > 0,
      hasDiscountCode: trimmedDiscount.length > 0,
    })

    try {
      await ensureAnonymousSession().catch(() => {
        // Best effort — proceed even if anon session fails; edge function
        // handles missing auth via GTG_SERVICE_ACCOUNT_ID fallback.
      })

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

      const attemptKey = checkoutAttemptKeyRef.current ?? loadOrCreateCheckoutIdempotencyKey(product.sku)
      checkoutAttemptKeyRef.current = attemptKey

      const checkoutAbortController = new AbortController()
      const checkoutTimeout = window.setTimeout(() => {
        checkoutAbortController.abort()
      }, CHECKOUT_REQUEST_TIMEOUT_MS)

      const selectedAddons: Array<'roses_carnations' | 'roses_only' | 'humidor'> = [
        ...(flowerAddon ? [flowerAddon] : []),
        ...(humidorAddon ? ['humidor' as const] : []),
      ]

      let result
      try {
        result = await createOrderWithSessionRecovery({
          productId: product.id,
          quantity: 1,
          customerName: trimmedName,
          customerEmail: trimmedEmail,
          idempotencyKey: attemptKey,
          shippingAddress: {
            line1: trimmedShippingLine1,
            line2: trimmedShippingLine2 || null,
            city: trimmedShippingCity,
            state: trimmedShippingState,
            postalCode: trimmedShippingZip,
            country: 'US',
          },
          ...(consultantId ? { consultantId } : {}),
          ...(trimmedDiscount ? { discountCode: trimmedDiscount } : {}),
          ...(selectedAddons.length > 0 ? { addons: selectedAddons } : {}),
          ...(giftRecipient.trim() ? { giftRecipient: giftRecipient.trim() } : {}),
          ...(giftOccasion.trim() ? { giftOccasion: giftOccasion.trim() } : {}),
          ...(giftNote.trim() ? { giftNote: giftNote.trim() } : {}),
        }, {
          signal: checkoutAbortController.signal,
        })
      } finally {
        window.clearTimeout(checkoutTimeout)
      }

      setServerOrderTotalCents(result.total_cents)

      const stripe = stripeClientRef.current ?? await loadStripeClient(stripePublishableKey)
      stripeClientRef.current = stripe

      if (!stripeCardElementRef.current) {
        throw new Error('Secure payment field did not finish loading. Please refresh and try again.')
      }

      const paymentResult = await stripe.confirmCardPayment(result.client_secret, {
        payment_method: {
          card: stripeCardElementRef.current,
          billing_details: {
            name: trimmedName,
            email: trimmedEmail,
            address: {
              line1: effectiveBillingLine1,
              line2: effectiveBillingLine2 || null,
              city: effectiveBillingCity,
              state: effectiveBillingState,
              postal_code: effectiveBillingZip,
              country: 'US',
            },
          },
        },
      })

      if (paymentResult.error?.message) {
        throw new Error(paymentResult.error.message)
      }

      if (!paymentResult.paymentIntent) {
        throw new Error('Payment confirmation did not complete. Please try again.')
      }

      storeCheckoutSession(result, trimmedName, trimmedEmail, result.total_cents)
      const storedSession = loadCheckoutSession()
      setConfirmedSession(storedSession)
      setConfirmedOrderId(result.order_id)

      trackStorefrontEvent('checkout_redirected', {
        sku: product.sku,
        orderId: result.order_id,
        orderNumber: result.order_number,
        paymentIntentId: result.payment_intent_id,
      })
      setPhase('confirmed')
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
  const orderTotal = serverOrderTotalCents ?? (product ? product.retail_price_cents + addonTotalCents : 0)

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
                {flowerAddon === 'roses_carnations' ? (
                  <div className="checkout-page-order-line">
                    <span>Roses with Carnations</span>
                    <strong>+$45.00</strong>
                  </div>
                ) : null}
                {flowerAddon === 'roses_only' ? (
                  <div className="checkout-page-order-line">
                    <span>Roses without Carnations</span>
                    <strong>+$35.00</strong>
                  </div>
                ) : null}
                {humidorAddon ? (
                  <div className="checkout-page-order-line">
                    <span>Cigar Humidor</span>
                    <strong>+$40.00</strong>
                  </div>
                ) : null}
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

                {/* ── Gift personalization ── */}
                <section className="checkout-gift-section" aria-label="Gift personalization">
                  <p className="checkout-gift-heading">Gift Personalization <span className="checkout-field-optional">(optional)</span></p>
                  <p className="checkout-gift-copy">Personalize this order with who it&apos;s for and a note worth keeping.</p>

                  <div className="checkout-field">
                    <label htmlFor="cp-gift-recipient">
                      Recipient
                      <span className="checkout-field-optional"> (optional)</span>
                    </label>
                    <input
                      id="cp-gift-recipient"
                      type="text"
                      value={giftRecipient}
                      onChange={(event) => setGiftRecipient(event.target.value)}
                      placeholder="Dad, coach, alum, veteran..."
                      disabled={isSubmitting}
                    />
                  </div>

                  <div className="checkout-field">
                    <label htmlFor="cp-gift-occasion">
                      Occasion
                      <span className="checkout-field-optional"> (optional)</span>
                    </label>
                    <input
                      id="cp-gift-occasion"
                      type="text"
                      value={giftOccasion}
                      onChange={(event) => setGiftOccasion(event.target.value)}
                      placeholder="Father's Day, graduation, retirement..."
                      disabled={isSubmitting}
                    />
                  </div>

                  <div className="checkout-field">
                    <label htmlFor="cp-gift-note">
                      Gift note
                      <span className="checkout-field-optional"> (optional)</span>
                    </label>
                    <textarea
                      id="cp-gift-note"
                      value={giftNote}
                      onChange={(event) => setGiftNote(event.target.value)}
                      placeholder="Giving you your flowers..."
                      rows={3}
                      disabled={isSubmitting}
                    />
                  </div>
                </section>

                {/* ── Shipping address ── */}
                <section className="checkout-address-section" aria-label="Shipping address">
                  <p className="checkout-address-heading">Shipping Address</p>

                  <div className="checkout-field">
                    <label htmlFor="cp-ship-line1">Street address</label>
                    <input
                      id="cp-ship-line1"
                      type="text"
                      value={shippingLine1}
                      onChange={(event) => { setShippingLine1(event.target.value); clearError() }}
                      placeholder="123 Main St"
                      autoComplete="shipping address-line1"
                      required
                      disabled={isSubmitting}
                    />
                  </div>

                  <div className="checkout-field">
                    <label htmlFor="cp-ship-line2">
                      Apt, suite, etc.
                      <span className="checkout-field-optional"> (optional)</span>
                    </label>
                    <input
                      id="cp-ship-line2"
                      type="text"
                      value={shippingLine2}
                      onChange={(event) => { setShippingLine2(event.target.value) }}
                      placeholder="Apt 4B"
                      autoComplete="shipping address-line2"
                      disabled={isSubmitting}
                    />
                  </div>

                  <div className="checkout-address-row">
                    <div className="checkout-field checkout-address-city">
                      <label htmlFor="cp-ship-city">City</label>
                      <input
                        id="cp-ship-city"
                        type="text"
                        value={shippingCity}
                        onChange={(event) => { setShippingCity(event.target.value); clearError() }}
                        placeholder="New York"
                        autoComplete="shipping address-level2"
                        required
                        disabled={isSubmitting}
                      />
                    </div>
                    <div className="checkout-field checkout-address-state">
                      <label htmlFor="cp-ship-state">State</label>
                      <input
                        id="cp-ship-state"
                        type="text"
                        value={shippingState}
                        onChange={(event) => { setShippingState(event.target.value); clearError() }}
                        placeholder="NY"
                        autoComplete="shipping address-level1"
                        maxLength={2}
                        required
                        disabled={isSubmitting}
                      />
                    </div>
                    <div className="checkout-field checkout-address-zip">
                      <label htmlFor="cp-ship-zip">ZIP code</label>
                      <input
                        id="cp-ship-zip"
                        type="text"
                        value={shippingZip}
                        onChange={(event) => { setShippingZip(event.target.value); clearError() }}
                        placeholder="10001"
                        autoComplete="shipping postal-code"
                        required
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>
                </section>

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

                {/* ── Add-ons ── */}
                <section className="checkout-addons-section" aria-label="Optional add-ons">
                  <p className="checkout-addons-heading">Add to Your Gift <span className="checkout-field-optional">(optional)</span></p>
                  <p className="checkout-addons-copy">These items ship with your vase order.</p>

                  <div className="checkout-addon-list">
                    <label className="checkout-addon-option">
                      <input
                        type="checkbox"
                        checked={flowerAddon === 'roses_carnations'}
                        onChange={(event) => setFlowerAddon(event.target.checked ? 'roses_carnations' : null)}
                        disabled={isSubmitting}
                      />
                      <span className="checkout-addon-label">Roses with Carnations</span>
                      <span className="checkout-addon-price">+$45.00</span>
                    </label>

                    <label className="checkout-addon-option">
                      <input
                        type="checkbox"
                        checked={flowerAddon === 'roses_only'}
                        onChange={(event) => setFlowerAddon(event.target.checked ? 'roses_only' : null)}
                        disabled={isSubmitting}
                      />
                      <span className="checkout-addon-label">Roses without Carnations</span>
                      <span className="checkout-addon-price">+$35.00</span>
                    </label>

                    <label className="checkout-addon-option">
                      <input
                        type="checkbox"
                        checked={humidorAddon}
                        onChange={(event) => setHumidorAddon(event.target.checked)}
                        disabled={isSubmitting}
                      />
                      <span className="checkout-addon-label">Cigar Humidor</span>
                      <span className="checkout-addon-price">+$40.00</span>
                    </label>
                  </div>
                </section>

                <section className="checkout-payment-section" aria-label="Payment step">
                  <div className="checkout-payment-head">
                    <p className="checkout-payment-eyebrow">Payment</p>
                    <h2 className="checkout-payment-title">Secure your order with server-verified pricing.</h2>
                    <p className="checkout-payment-copy">
                      Pricing and inventory are locked on the server before Stripe confirms your card.
                    </p>
                  </div>

                  <div className="checkout-payment-summary">
                    <div className="checkout-payment-line">
                      <span>Secure total</span>
                      <strong>{formatCents(orderTotal)}</strong>
                    </div>
                    <div className="checkout-payment-line">
                      <span>Shipping</span>
                      <strong>Included</strong>
                    </div>
                  </div>

                  {/* ── Billing address ── */}
                  <div className="checkout-billing-same">
                    <label className="checkout-billing-same-label">
                      <input
                        type="checkbox"
                        checked={billingSameAsShipping}
                        onChange={(event) => { setBillingSameAsShipping(event.target.checked) }}
                        disabled={isSubmitting}
                      />
                      <span>Billing address same as shipping</span>
                    </label>
                  </div>

                  {!billingSameAsShipping ? (
                    <section className="checkout-address-section" aria-label="Billing address">
                      <p className="checkout-address-heading">Billing Address</p>

                      <div className="checkout-field">
                        <label htmlFor="cp-bill-line1">Street address</label>
                        <input
                          id="cp-bill-line1"
                          type="text"
                          value={billingLine1}
                          onChange={(event) => { setBillingLine1(event.target.value); clearError() }}
                          placeholder="123 Main St"
                          autoComplete="billing address-line1"
                          required
                          disabled={isSubmitting}
                        />
                      </div>

                      <div className="checkout-field">
                        <label htmlFor="cp-bill-line2">
                          Apt, suite, etc.
                          <span className="checkout-field-optional"> (optional)</span>
                        </label>
                        <input
                          id="cp-bill-line2"
                          type="text"
                          value={billingLine2}
                          onChange={(event) => { setBillingLine2(event.target.value) }}
                          placeholder="Apt 4B"
                          autoComplete="billing address-line2"
                          disabled={isSubmitting}
                        />
                      </div>

                      <div className="checkout-address-row">
                        <div className="checkout-field checkout-address-city">
                          <label htmlFor="cp-bill-city">City</label>
                          <input
                            id="cp-bill-city"
                            type="text"
                            value={billingCity}
                            onChange={(event) => { setBillingCity(event.target.value); clearError() }}
                            placeholder="New York"
                            autoComplete="billing address-level2"
                            required
                            disabled={isSubmitting}
                          />
                        </div>
                        <div className="checkout-field checkout-address-state">
                          <label htmlFor="cp-bill-state">State</label>
                          <input
                            id="cp-bill-state"
                            type="text"
                            value={billingState}
                            onChange={(event) => { setBillingState(event.target.value); clearError() }}
                            placeholder="NY"
                            autoComplete="billing address-level1"
                            maxLength={2}
                            required
                            disabled={isSubmitting}
                          />
                        </div>
                        <div className="checkout-field checkout-address-zip">
                          <label htmlFor="cp-bill-zip">ZIP code</label>
                          <input
                            id="cp-bill-zip"
                            type="text"
                            value={billingZip}
                            onChange={(event) => { setBillingZip(event.target.value); clearError() }}
                            placeholder="10001"
                            autoComplete="billing postal-code"
                            required
                            disabled={isSubmitting}
                          />
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <div className="checkout-field">
                    <label htmlFor="cp-card">Card details</label>
                    <div
                      id="cp-card"
                      ref={cardMountRef}
                      className="checkout-card-element"
                      aria-live="polite"
                    />
                    {cardErrorMessage ? (
                      <p className="checkout-field-hint checkout-field-hint--error">{cardErrorMessage}</p>
                    ) : null}
                  </div>

                  <div className="checkout-payment-trust" role="list" aria-label="Payment assurances">
                    <span role="listitem">Stripe-secured card payment</span>
                    <span role="listitem">Encrypted payment processing</span>
                    <span role="listitem">Receipt sent instantly by email</span>
                  </div>

                  <Button
                    type="submit"
                    variant="gold"
                    size="lg"
                    className="checkout-submit"
                    disabled={isSubmitting || !checkoutEnabled || !cardReady}
                    aria-busy={isSubmitting}
                  >
                    {isSubmitting ? (
                      <>
                        <span className="checkout-spinner" aria-hidden="true" />
                        {CHECKOUT_SUBMITTING}
                      </>
                    ) : (
                      `Pay Securely — ${formatCents(orderTotal)}`
                    )}
                  </Button>
                </section>

                <p className="checkout-stripe-note">
                  Payment processed by Stripe. Game Time Gift never calculates or stores your card data in the browser.
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
