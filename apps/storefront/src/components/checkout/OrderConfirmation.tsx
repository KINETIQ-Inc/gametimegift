/**
 * OrderConfirmation — full-page screen shown after a successful Stripe payment.
 *
 * Rendered when the app detects ?gtg_checkout=success on mount, which
 * Stripe appends to our successUrl after a completed payment.
 *
 * CONTENT STRATEGY:
 *   - If session data is present (typical): show product name, price,
 *     serial number, and customer email.
 *   - If session data is missing (storage cleared / private mode): show
 *     a generic confirmation with no order-specific details.
 *
 * ACTIONS:
 *   - "Verify Hologram" — passes the serial number up to App so the
 *     verify section can be pre-filled and scrolled into view.
 *   - "Continue Shopping" — clears the confirmation and returns to catalog.
 */

import { useEffect, useState } from 'react'
import { fetchOrderById } from '@gtg/api'
import { Button, Heading } from '@gtg/ui'
import {
  SUCCESS_CONFIRMED,
  SUCCESS_FALLBACK,
  SUCCESS_SYNC_DELAYED,
  SUCCESS_SYNCING,
} from '../../checkout-copy'
import { trackStorefrontEvent } from '../../analytics'
import type { StoredCheckoutSession } from '../../checkout-flow'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(cents / 100)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderConfirmationProps {
  orderId: string | null
  session: StoredCheckoutSession | null
  /**
   * Called when the customer clicks "Verify Hologram Serial".
   * Passes the serial number so the parent can pre-fill the verify section.
   * The parent is responsible for clearing the confirmation state.
   */
  onVerify: (serialNumber: string) => void
  /** Called when the customer clicks "Continue Shopping". */
  onContinue: () => void
}

type OrderSyncPhase = 'idle' | 'syncing' | 'ready' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

const ORDER_SYNC_TIMEOUT_MS = 15_000
const ORDER_SYNC_POLL_MS = 1_500

export function OrderConfirmation({ orderId, session, onVerify, onContinue }: OrderConfirmationProps) {
  const hasSession = session !== null
  const resolvedOrderId = orderId ?? session?.orderId ?? null
  const [syncPhase, setSyncPhase] = useState<OrderSyncPhase>(resolvedOrderId ? 'syncing' : 'idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [resolvedOrderNumber, setResolvedOrderNumber] = useState<string | null>(
    session?.orderNumber ?? null,
  )

  useEffect(() => {
    if (resolvedOrderId) {
      trackStorefrontEvent('confirmation_viewed', {
        orderId: resolvedOrderId,
        orderNumber: session?.orderNumber ?? null,
        sku: session?.sku ?? null,
      })
    }
  }, [resolvedOrderId, session])

  useEffect(() => {
    if (!resolvedOrderId) {
      setSyncPhase('idle')
      setSyncMessage(null)
      setResolvedOrderNumber(session?.orderNumber ?? null)
      return
    }

    const activeOrderId = resolvedOrderId
    let cancelled = false
    const startedAt = Date.now()
    let timeoutId: number | null = null

    // The ledger pipeline (commissions, hologram registration, status
    // transition to 'paid') is triggered server-side by the Stripe webhook,
    // not by this component. We poll fetchOrderById to observe when the
    // webhook has processed the order and its status has advanced.
    async function syncOrder(): Promise<void> {
      try {
        const result = await fetchOrderById({
          orderId: activeOrderId,
          includeLines: false,
        })

        if (cancelled) return

        if (!result) {
          if (Date.now() - startedAt < ORDER_SYNC_TIMEOUT_MS) {
            timeoutId = window.setTimeout(() => { void syncOrder() }, ORDER_SYNC_POLL_MS)
            return
          }

          setSyncPhase('error')
          setSyncMessage(SUCCESS_FALLBACK)
          return
        }

        setResolvedOrderNumber(result.order.order_number ?? session?.orderNumber ?? null)

        if (result.order.status === 'pending_payment' && Date.now() - startedAt < ORDER_SYNC_TIMEOUT_MS) {
          setSyncPhase('syncing')
          setSyncMessage(SUCCESS_SYNCING)
          timeoutId = window.setTimeout(() => { void syncOrder() }, ORDER_SYNC_POLL_MS)
          return
        }

        if (result.order.status === 'pending_payment') {
          setSyncPhase('error')
          setSyncMessage(SUCCESS_SYNC_DELAYED)
          return
        }

        setSyncPhase('ready')
        setSyncMessage(null)
      } catch {
        if (cancelled) return

        if (Date.now() - startedAt < ORDER_SYNC_TIMEOUT_MS) {
          timeoutId = window.setTimeout(() => { void syncOrder() }, ORDER_SYNC_POLL_MS)
          return
        }

        setSyncPhase('error')
        setSyncMessage(SUCCESS_FALLBACK)
      }
    }

    void syncOrder()

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [resolvedOrderId, session])

  return (
    <div className="confirmation-shell">
      <div className="confirmation-card">

        {/* ── Seal / decoration ── */}
        <div className="confirmation-seal" aria-hidden="true">✦</div>
        <p className="confirmation-eyebrow">Order Review</p>

        {/* ── Headline ── */}
        <Heading as="h1" className="confirmation-title">Order Confirmed</Heading>

        {hasSession ? (
          <>
            {/* ── Product summary ── */}
            <div className="confirmation-hero">
              <p className="confirmation-product-name">{session.productName}</p>
              <p className="confirmation-product-price">{formatCents(session.retailPriceCents)}</p>
              <p className="confirmation-hero-copy">
                Your collectible gift has been secured. Order details are below, along with the hologram serial you can use for lifetime authenticity verification.
              </p>
            </div>

            {/* ── Order details ── */}
            <dl className="confirmation-details">
              <div className="confirmation-detail-row">
                <dt>Order Number</dt>
                <dd>{resolvedOrderNumber ?? session.orderNumber}</dd>
              </div>
              <div className="confirmation-detail-row">
                <dt>Hologram Serial</dt>
                <dd className="confirmation-serial">{session.serialNumber}</dd>
              </div>
              <div className="confirmation-detail-row">
                <dt>SKU</dt>
                <dd>{session.sku}</dd>
              </div>
              <div className="confirmation-detail-row">
                <dt>Confirmation to</dt>
                <dd>{session.customerEmail}</dd>
              </div>
              {session.channel === 'consultant_assisted' ? (
                <div className="confirmation-detail-row">
                  <dt>Channel</dt>
                  <dd>Consultant Assisted</dd>
                </div>
              ) : null}
            </dl>

            <div className="confirmation-next-steps" aria-label="What happens next">
              <p className="confirmation-next-steps__eyebrow">What Happens Next</p>
              <ul className="confirmation-next-steps__list">
                <li>Your confirmation email is on the way to {session.customerEmail}.</li>
                <li>Your order is being registered to its hologram-backed authenticity record.</li>
                <li>Keep your serial number for future verification and provenance checks.</li>
              </ul>
            </div>

            {syncPhase !== 'ready' ? (
              <p className="confirmation-body confirmation-body--syncing">
                {syncMessage ?? SUCCESS_SYNCING}
              </p>
            ) : (
              <p className="confirmation-body">{SUCCESS_CONFIRMED}</p>
            )}

            {/* ── Actions ── */}
            <div className="confirmation-actions">
              <Button
                type="button"
                variant="gold"
                size="lg"
                onClick={() => onVerify(session.serialNumber)}
              >
                Verify Hologram Serial
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"

                onClick={onContinue}
              >
                Continue Shopping
              </Button>
            </div>
          </>
        ) : (
          /* ── Fallback when session storage was unavailable ── */
          <>
            <p className="confirmation-body">
              {syncMessage ?? SUCCESS_FALLBACK}
            </p>
            {resolvedOrderNumber ? (
              <dl className="confirmation-details">
                <div className="confirmation-detail-row">
                  <dt>Order Number</dt>
                  <dd>{resolvedOrderNumber}</dd>
                </div>
              </dl>
            ) : null}
            <div className="confirmation-actions">
              <Button
                type="button"
                variant="gold"
                size="lg"
                onClick={onContinue}
              >
                Return to Catalog
              </Button>
            </div>
          </>
        )}

        {/* ── Certificate strip ── */}
        <div className="confirmation-cert-strip">
          <span>NCAA Licensed</span>
          <span aria-hidden="true">·</span>
          <span>Military Licensed</span>
          <span aria-hidden="true">·</span>
          <span>Hologram Verified</span>
        </div>
      </div>
    </div>
  )
}
