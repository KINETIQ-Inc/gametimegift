import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@gtg/supabase', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '@gtg/supabase'
import { processOrderLedger, submitOrder } from '../orders'

const invokeMock = vi.fn()
const getSupabaseClientMock = vi.mocked(getSupabaseClient)

const UUID = '123e4567-e89b-42d3-a456-426614174000'

beforeEach(() => {
  invokeMock.mockReset()
  getSupabaseClientMock.mockReturnValue({
    functions: {
      invoke: invokeMock,
    },
  } as unknown as ReturnType<typeof getSupabaseClient>)
})

describe('ledger pipeline contract', () => {
  it('submitOrder calls process-order-ledger with order_id payload', async () => {
    invokeMock.mockResolvedValue({
      data: {
        phase: '5A-5C',
        pipeline: 'processOrderLedger',
        order_id: UUID,
        success: true,
        status: 'completed',
        completed_steps: 9,
        total_steps: 9,
        steps: [],
        errors: [],
      },
      error: null,
    })

    await submitOrder({ orderId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('process-order-ledger', {
      body: { order_id: UUID },
    })
  })

  it('processOrderLedger delegates to process-order-ledger with order_id payload', async () => {
    invokeMock.mockResolvedValue({
      data: {
        phase: '5A-5C',
        pipeline: 'processOrderLedger',
        order_id: UUID,
        success: true,
        status: 'completed',
        completed_steps: 9,
        total_steps: 9,
        steps: [],
        errors: [],
      },
      error: null,
    })

    await processOrderLedger({ orderId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('process-order-ledger', {
      body: { order_id: UUID },
    })
  })

  it('process-order-ledger function enforces admin authorization', () => {
    const sourcePath = resolve(process.cwd(), 'supabase/functions/process-order-ledger/index.ts')
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).toContain("import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'")
    expect(source).toContain('verifyRole(user, ADMIN_ROLES, req)')
  })

  it('process-order-ledger uses modular step architecture', () => {
    const sourcePath = resolve(process.cwd(), 'supabase/functions/process-order-ledger/index.ts')
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).toContain("from './steps/validate-order.ts'")
    expect(source).toContain("from './steps/reserve-inventory.ts'")
    expect(source).toContain("from './steps/record-ledger.ts'")
    expect(source).toContain("from './steps/compute-commission.ts'")
    expect(source).toContain("from './steps/apply-royalty.ts'")
    expect(source).toContain("from './steps/finalize-order.ts'")
  })
})
