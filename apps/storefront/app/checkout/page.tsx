'use client'

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { Button } from '@gtg/ui'
import {
  createOrder,
  listProducts,
  processOrderLedger,
  resolveConsultantCode,
  toUserMessage,
  type CreateCheckoutSessionResult,
  type ProductListItem,
  type SubmitOrderResult,
} from '@gtg/api'
import { APP_ROUTE_PRODUCTS } from '../_lib/mock-storefront'
import { AppActionLink, AppStatePanel, appCardStyle } from '../_lib/route-ui'
import { loadAppReferralCode } from '../_lib/referral-storage'

type CheckoutPhase = 'loading' | 'ready' | 'submitting' | 'success' | 'error'

const mockDisplayProduct = APP_ROUTE_PRODUCTS[0]

function fieldStyle(): CSSProperties {
  return {
    minHeight: 44,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid #d1d8e0',
  }
}

export default function CheckoutPage() {
  const [phase, setPhase] = useState<CheckoutPhase>('loading')
  const [product, setProduct] = useState<ProductListItem | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [orderResult, setOrderResult] = useState<CreateCheckoutSessionResult | null>(null)
  const [ledgerResult, setLedgerResult] = useState<SubmitOrderResult | null>(null)
  const [consultantCode, setConsultantCode] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function loadProduct(): Promise<void> {
      try {
        const result = await listProducts({ limit: 1, offset: 0 })
        if (!active) return

        if (result.products.length > 0) {
          setProduct(result.products[0])
        }

        setPhase('ready')
      } catch {
        if (!active) return
        setPhase('ready')
      }
    }

    void loadProduct()

    setConsultantCode(loadAppReferralCode())

    return () => {
      active = false
    }
  }, [])

  const displayProduct = useMemo(
    () => ({
      name: product?.name ?? mockDisplayProduct.name,
      description: product?.description ?? mockDisplayProduct.summary,
      price:
        product !== null
          ? `$${(product.retail_price_cents / 100).toFixed(2)}`
          : mockDisplayProduct.price,
    }),
    [product],
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!product) {
      setErrorMessage('Checkout is unavailable until a live product is loaded from the API.')
      setPhase('error')
      return
    }

    if (!customerName.trim() || !customerEmail.trim()) {
      setErrorMessage('Enter your full name and email to complete the order.')
      setPhase('error')
      return
    }

    setErrorMessage(null)
    setPhase('submitting')

    try {
      const successUrl = `${window.location.origin}/checkout?status=success`
      const cancelUrl = `${window.location.origin}/checkout?status=cancelled`
      let consultantId: string | undefined

      if (consultantCode) {
        const resolvedConsultant = await resolveConsultantCode(consultantCode)
        consultantId = resolvedConsultant?.consultant_id
      }

      const createdOrder = await createOrder({
        productId: product.id,
        quantity: 1,
        customerName,
        customerEmail,
        successUrl,
        cancelUrl,
        ...(consultantId ? { consultantId } : {}),
      })

      setOrderResult(createdOrder)

      const processedLedger = await processOrderLedger({
        orderId: createdOrder.order_id,
      })

      if (!processedLedger.success) {
        throw new Error(
          processedLedger.errors[0]?.message ??
            processedLedger.failed_step ??
            'The order ledger did not complete successfully.',
        )
      }

      setLedgerResult(processedLedger)
      setPhase('success')
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'The order could not be completed.'))
      setPhase('error')
    }
  }

  const isSubmitting = phase === 'submitting'

  return (
    <main>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 0.82fr)',
          gap: 20,
        }}
      >
        <div style={appCardStyle()}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#92600a',
              fontWeight: 800,
            }}
          >
            Checkout Route
          </p>
          <h2 style={{ margin: '10px 0 12px', fontSize: 36 }}>Complete your order</h2>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            This is the single checkout route for the App Router scaffold. No modal checkout is used here.
          </p>

          {phase === 'loading' ? (
            <div style={{ marginTop: 22 }}>
              <AppStatePanel
                kind="loading"
                title="Loading state"
                message="Loading checkout details…"
              />
            </div>
          ) : null}

          {phase === 'success' ? (
            <div style={{ marginTop: 22 }}>
              <AppStatePanel
                kind="success"
                title="Success state"
                message={
                  <>
                    <span>
                      Order {orderResult?.order_number ?? orderResult?.order_id ?? 'created'} has been sent
                      through the ledger pipeline.
                    </span>
                    <br />
                    <span>Status: {ledgerResult?.status ?? 'completed'}</span>
                  </>
                }
              />
            </div>
          ) : (
            <form style={{ display: 'grid', gap: 14, marginTop: 22 }} onSubmit={(event) => void handleSubmit(event)}>
              <label style={{ display: 'grid', gap: 8 }}>
                <span style={{ fontWeight: 700 }}>Full name</span>
                <input
                  type="text"
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                  placeholder="Jane Smith"
                  style={fieldStyle()}
                  disabled={isSubmitting}
                />
              </label>
              <label style={{ display: 'grid', gap: 8 }}>
                <span style={{ fontWeight: 700 }}>Email</span>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(event) => setCustomerEmail(event.target.value)}
                  placeholder="jane@example.com"
                  style={fieldStyle()}
                  disabled={isSubmitting}
                />
              </label>

              {phase === 'error' && errorMessage ? (
                <AppStatePanel
                  kind="error"
                  title="Error state"
                  message={errorMessage}
                />
              ) : null}

              <Button
                type="submit"
                variant="gold"
                size="lg"
                disabled={phase === 'loading'}
                loading={isSubmitting}
              >
                Complete Order
              </Button>
            </form>
          )}
        </div>

        <aside
          style={{
            ...appCardStyle(),
            background: '#eef3fb',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 12,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#4a5568',
              fontWeight: 800,
            }}
          >
            Product Summary
          </p>
          <h3 style={{ margin: '10px 0 8px', fontSize: 26 }}>{displayProduct.name}</h3>
          <p style={{ margin: 0, lineHeight: 1.6 }}>{displayProduct.description}</p>
          <p style={{ margin: '18px 0 0', fontSize: 30, fontWeight: 800, color: '#031b52' }}>
            {displayProduct.price}
          </p>
          <p style={{ margin: '12px 0 0', lineHeight: 1.6 }}>
            Total price is shown here before the order is submitted.
          </p>
          {!product && phase !== 'loading' ? (
            <div style={{ marginTop: 12 }}>
              <AppStatePanel
                kind="empty"
                title="Empty state"
                message="No live checkout product is loaded yet. Mock summary is being shown."
              />
            </div>
          ) : null}
          {consultantCode ? (
            <p style={{ margin: '12px 0 0', lineHeight: 1.6 }}>
              Referral applied: <strong>{consultantCode}</strong>
            </p>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 22 }}>
            <AppActionLink href="/shop" label="Back to Shop" tone="navy" />
            <AppActionLink href="/consultant" label="Consultant Route" tone="navy" />
          </div>
        </aside>
      </section>
    </main>
  )
}
