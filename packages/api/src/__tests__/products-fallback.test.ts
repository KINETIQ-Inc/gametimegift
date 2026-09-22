import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gtg/supabase', () => ({
  getSupabaseClient: vi.fn(),
  configureSupabase: vi.fn(),
  isSupabaseConfigured: vi.fn(() => true),
}))

import { getSupabaseClient } from '@gtg/supabase'
import { configureApiRuntime } from '../client'
import { listProductsWithFallback } from '../products'

const invokeMock = vi.fn()
const getSupabaseClientMock = vi.mocked(getSupabaseClient)
const loggerMock = vi.fn()

// A minimal chainable query-builder stand-in: every filter method returns
// itself, and it resolves like a real Supabase query when awaited (the
// query builder is thenable). Lets tests assert exactly which filters
// listProductsDirectly() applied.
function createChainableQuery(result: { data: unknown; error: unknown; count?: number | null }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {}
  for (const method of ['select', 'eq', 'order', 'range', 'ilike', 'in']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

beforeEach(() => {
  vi.useRealTimers()
  invokeMock.mockReset()
  loggerMock.mockReset()
  configureApiRuntime({
    retryAttempts: 2,
    retryBaseDelayMs: 0,
    logger: loggerMock,
  })
})

describe('listProductsWithFallback — never broadens results, never fabricates stock', () => {
  it('returns a successful empty result as-is — a real "no matches" is not a failure', async () => {
    invokeMock.mockResolvedValue({
      data: { data: { products: [], total: 0, limit: 50, offset: 0 } },
      error: null,
    })
    const fromMock = vi.fn()
    getSupabaseClientMock.mockReturnValue({
      functions: { invoke: invokeMock },
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
      from: fromMock,
    } as unknown as ReturnType<typeof getSupabaseClient>)

    const result = await listProductsWithFallback({ school: 'University of Florida' })

    expect(result).toEqual({ products: [], total: 0, limit: 50, offset: 0 })
    // The direct-table fallback must never run just because the real,
    // filtered answer happened to be empty — that would broaden the result
    // set behind the caller's back.
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('falls back to the direct query only when list-products itself is unreachable, and preserves every filter', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: 'upstream unavailable', status: 500 },
    })

    const directResult = {
      data: [
        {
          id: 'p1',
          sku: 'APP-CLEMSON-HOODIE-M',
          name: 'Clemson University Hoodie',
          description: null,
          school: 'Clemson University',
          license_body: 'CLC',
          category: 'APPAREL',
          lifecycle_status: 'ACTIVE',
          size: 'M',
          color: 'Navy',
          style_key: 'APP-CLEMSON-HOODIE',
          retail_price_cents: 4500,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      error: null,
      count: 1,
    }
    const chain = createChainableQuery(directResult)
    const fromMock = vi.fn(() => chain)

    getSupabaseClientMock.mockReturnValue({
      functions: { invoke: invokeMock },
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
      from: fromMock,
    } as unknown as ReturnType<typeof getSupabaseClient>)

    const result = await listProductsWithFallback({
      school: 'Clemson University',
      category: 'APPAREL',
      search: 'hoodie',
      style_key: 'APP-CLEMSON-HOODIE',
      license_body: 'CLC',
    })

    expect(fromMock).toHaveBeenCalledWith('products')
    // Every requested filter was applied to the direct query — none dropped.
    expect(chain.eq).toHaveBeenCalledWith('is_active', true)
    expect(chain.eq).toHaveBeenCalledWith('school', 'Clemson University')
    expect(chain.eq).toHaveBeenCalledWith('category', 'APPAREL')
    expect(chain.eq).toHaveBeenCalledWith('style_key', 'APP-CLEMSON-HOODIE')
    expect(chain.eq).toHaveBeenCalledWith('license_body', 'CLC')
    expect(chain.ilike).toHaveBeenCalledWith('name', '%hoodie%')

    // Never fabricated: the real availability join is service_role-only and
    // this path runs with the anon-key client, so it cannot know real stock.
    expect(result.products).toHaveLength(1)
    expect(result.products[0]).toMatchObject({ available_count: 0, in_stock: false })
    expect(result.total).toBe(1)
  })

  it('applies an array of license_body values with .in(), not .eq()', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: 'upstream unavailable', status: 500 },
    })
    const chain = createChainableQuery({ data: [], error: null, count: 0 })
    getSupabaseClientMock.mockReturnValue({
      functions: { invoke: invokeMock },
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
      from: vi.fn(() => chain),
    } as unknown as ReturnType<typeof getSupabaseClient>)

    await listProductsWithFallback({ license_body: ['CLC', 'ARMY'] })

    expect(chain.in).toHaveBeenCalledWith('license_body', ['CLC', 'ARMY'])
  })
})
