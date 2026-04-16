import { describe, expect, it } from 'vitest'
import {
  resolveExistingOrderIdempotency,
  type ExistingOrderRow,
} from '../create-checkout-session/idempotency'

function buildExistingOrder(overrides: Partial<ExistingOrderRow> = {}): ExistingOrderRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    order_number: 'GTG-1001',
    status: 'pending_payment',
    customer_email: 'buyer@example.com',
    checkout_idempotency_key: 'gtg-checkout-test-key-1001',
    checkout_idempotency_expires_at: '2026-04-15T21:45:00.000Z',
    checkout_response_cache: null,
    checkout_session_id: 'cs_test_cached',
    ...overrides,
  }
}

describe('create-checkout-session idempotency resolution', () => {
  it('returns cached response for an active idempotent retry', () => {
    const cachedResponse = {
      order_id: '11111111-1111-4111-8111-111111111111',
      order_number: 'GTG-1001',
      session_id: 'cs_test_cached',
      session_url: 'https://checkout.stripe.com/pay/cs_test_cached',
    }

    const resolution = resolveExistingOrderIdempotency(buildExistingOrder({
      checkout_response_cache: cachedResponse,
    }), Date.parse('2026-04-15T21:30:00.000Z'))

    expect(resolution).toEqual({
      kind: 'return_cached',
      cachedResponse,
    })
  })
})
