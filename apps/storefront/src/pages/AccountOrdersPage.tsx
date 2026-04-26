import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertBanner, Heading } from '@gtg/ui'
import { listMyOrders, toUserMessage, type CustomerOrderSummary } from '@gtg/api'
import { AccountShell } from '../components/account/AccountShell'

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

export function AccountOrdersPage() {
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    let active = true

    async function load(): Promise<void> {
      try {
        const nextOrders = await listMyOrders()
        if (!active) return
        setOrders(nextOrders)
      } catch (error) {
        if (!active) return
        setErrorMessage(toUserMessage(error, 'Unable to load your orders right now.'))
      } finally {
        if (!active) return
        setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  return (
    <AccountShell
      eyebrow="Orders"
      title="Every confirmed order, kept in one clean timeline."
      intro="When you check out while signed in, the order is attached to your customer account automatically so you can come back to it later."
    >
      {errorMessage ? <AlertBanner kind="error">{errorMessage}</AlertBanner> : null}

      {loading ? (
        <p className="account-empty-state">Loading your orders…</p>
      ) : orders.length === 0 ? (
        <div className="account-empty-state">
          <Heading as="h2" display={false}>No account-linked orders yet.</Heading>
          <p>
            Guest checkout still works, but new purchases made while signed in will show up here.
          </p>
          <Link to="/shop">Browse the collection</Link>
        </div>
      ) : (
        <div className="account-order-list">
          {orders.map((order) => (
            <article key={order.id} className="account-order-card">
              <div>
                <p className="account-order-card__eyebrow">Order {order.orderNumber}</p>
                <h2>{formatCurrency(order.totalCents)}</h2>
                <p className="account-order-card__meta">
                  {formatDate(order.createdAt)} · {order.productCount} item{order.productCount === 1 ? '' : 's'}
                </p>
              </div>
              <dl className="account-order-card__stats">
                <div>
                  <dt>Status</dt>
                  <dd>{order.status.replace(/_/g, ' ')}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{order.channel.replace(/_/g, ' ')}</dd>
                </div>
                <div>
                  <dt>Paid</dt>
                  <dd>{order.paidAt ? formatDate(order.paidAt) : 'Pending'}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </AccountShell>
  )
}
