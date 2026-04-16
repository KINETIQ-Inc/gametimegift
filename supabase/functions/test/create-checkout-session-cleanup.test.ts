import { describe, expect, it, vi } from 'vitest'
import { cleanupFailedCheckoutAttempt } from '../create-checkout-session/cleanup'

describe('create-checkout-session failure cleanup', () => {
  it('releases the reserved unit and deletes the orphan pending order', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const finalEq = vi.fn().mockResolvedValue({ error: null })
    const firstEq = vi.fn().mockReturnValue({ eq: finalEq })
    const deleteFn = vi.fn().mockReturnValue({ eq: firstEq })
    const from = vi.fn().mockReturnValue({ delete: deleteFn })
    const warn = vi.fn()
    const error = vi.fn()

    await cleanupFailedCheckoutAttempt({
      admin: {
        rpc,
        from,
      },
      unitId: '22222222-2222-4222-8222-222222222222',
      orderId: '11111111-1111-4111-8111-111111111111',
      releasedBy: '33333333-3333-4333-8333-333333333333',
      log: { warn, error },
      context: { stage: 'stripe_session_create' },
    })

    expect(rpc).toHaveBeenCalledWith('release_reserved_unit', {
      p_unit_id: '22222222-2222-4222-8222-222222222222',
      p_order_id: '11111111-1111-4111-8111-111111111111',
      p_released_by: '33333333-3333-4333-8333-333333333333',
      p_reason: 'Checkout session creation failed before payment could begin.',
    })
    expect(from).toHaveBeenCalledWith('orders')
    expect(deleteFn).toHaveBeenCalledTimes(1)
    expect(firstEq).toHaveBeenCalledWith('id', '11111111-1111-4111-8111-111111111111')
    expect(finalEq).toHaveBeenCalledWith('status', 'pending_payment')
    expect(error).not.toHaveBeenCalled()
  })
})
