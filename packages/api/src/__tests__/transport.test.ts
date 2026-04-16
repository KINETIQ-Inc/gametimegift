import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gtg/supabase', () => ({
  getSupabaseClient: vi.fn(),
  configureSupabase: vi.fn(),
  isSupabaseConfigured: vi.fn(() => true),
}))

import { getSupabaseClient } from '@gtg/supabase'
import { configureApiRuntime } from '../client'
import { ApiRequestError } from '../error'
import { invokeFunction } from '../transport'

type InvokeReturn = {
  data: unknown
  error: { message: string; status?: number } | null
}

const invokeMock = vi.fn<(...args: unknown[]) => Promise<InvokeReturn>>()
const getSupabaseClientMock = vi.mocked(getSupabaseClient)
const loggerMock = vi.fn()

beforeEach(() => {
  vi.useRealTimers()
  invokeMock.mockReset()
  loggerMock.mockReset()
  configureApiRuntime({
    retryAttempts: 2,
    retryBaseDelayMs: 0,
    logger: loggerMock,
  })
  getSupabaseClientMock.mockReturnValue({
    functions: {
      invoke: invokeMock,
    },
  } as unknown as ReturnType<typeof getSupabaseClient>)
})

describe('transport resilience', () => {
  it('retries transient function failures and succeeds', async () => {
    invokeMock
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'upstream unavailable', status: 503 },
      })
      .mockResolvedValueOnce({
        data: { data: { ok: true } },
        error: null,
      })

    await expect(invokeFunction<{ ok: boolean }>('health-check', {}, 'testCaller')).resolves.toEqual({
      ok: true,
    })

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(loggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invoke_retry',
        functionName: 'health-check',
        callerName: 'testCaller',
        attempt: 1,
      }),
    )
  })

  it('does not retry non-transient function failures', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: 'bad request', status: 400 },
    })

    await expect(invokeFunction('health-check', {}, 'testCaller')).rejects.toMatchObject({
      code: 'FUNCTION_ERROR',
      statusCode: 400,
    })

    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('guards invalid function names before any invocation', async () => {
    await expect(invokeFunction('HealthCheck', {}, 'testCaller')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiRequestError>)

    expect(invokeMock).not.toHaveBeenCalled()
  })
})
