/**
 * Centralized transport layer for @gtg/api.
 *
 * TRANSPORT RULES (enforced here, not in domain modules)
 * ──────────────────────────────────────────────────────
 *
 * 1. Auth propagation
 *    All Edge Function calls go through the Supabase client, which
 *    automatically includes the active session JWT in the Authorization header.
 *    Domain modules never construct auth headers manually.
 *
 * 2. Base URL handling
 *    The Supabase project URL is set once at configureApiClient() and held
 *    in the singleton client. Domain modules never reference URLs directly.
 *
 * 3. Typed request/response flow
 *    `invokeFunction<T>` enforces that:
 *      - Request bodies are plain JSON-serializable objects
 *      - Responses are unwrapped from the FunctionEnvelope<T> wire format
 *      - The returned value is typed as T (not `unknown`)
 *
 * 4. Centralized error normalization
 *    All invocation failures produce ApiRequestError with a discriminable
 *    code field. Domain modules never construct their own error objects for
 *    edge function calls — they rely on this layer.
 *
 * BOUNDARY RULE
 * ─────────────
 * App code (storefront, admin, consultant apps) imports only from @gtg/api.
 * No app may import @gtg/supabase directly. getClient() in client.ts is the
 * only approved way for app code to obtain a Supabase client reference
 * (for auth session management only).
 *
 * Within this package, @gtg/supabase is imported ONLY in this file and in
 * client.ts (configuration entry point). No domain module may import
 * @gtg/supabase directly. Use getTableClient() below for all table reads.
 *
 * 5. Unified error/success contract
 *    Every function in this module — regardless of variant — satisfies:
 *      Success: returns T (typed)
 *      Failure: throws ApiRequestError with .code and .message
 *    The four invoke variants differ only in how they call the backend,
 *    not in how they handle errors. Callers see a single contract.
 *
 * 6. Table read access
 *    getTableClient() is the only way domain modules access the Supabase
 *    query builder for direct table reads. All financial writes must go
 *    through an invokeFunction* call — never through getTableClient().
 */

import { getSupabaseClient } from '@gtg/supabase'
export type { Database } from '@gtg/supabase'
import { ApiRequestError, isTransientError } from './error'
import type { FunctionEnvelope } from './_internal'

export interface InvokeFunctionOptions {
  signal?: AbortSignal
}

export type ApiTransportLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ApiTransportLogEntry {
  level: ApiTransportLogLevel
  event:
    | 'invoke_start'
    | 'invoke_success'
    | 'invoke_retry'
    | 'invoke_failure'
    | 'invoke_validation_failure'
  functionName: string
  callerName: string
  attempt: number
  maxAttempts: number
  elapsedMs?: number
  statusCode?: number
  code?: string
  message?: string
}

export type ApiTransportLogger = (entry: ApiTransportLogEntry) => void

export interface ApiTransportConfig {
  retryAttempts?: number
  retryBaseDelayMs?: number
  logger?: ApiTransportLogger | null
}

const transportConfig: {
  retryAttempts: number
  retryBaseDelayMs: number
  logger: ApiTransportLogger
} = {
  retryAttempts: 2,
  retryBaseDelayMs: 250,
  logger: defaultTransportLogger,
}

export function configureApiTransport(config: ApiTransportConfig): void {
  if (config.retryAttempts !== undefined) {
    transportConfig.retryAttempts = Math.max(0, Math.floor(config.retryAttempts))
  }
  if (config.retryBaseDelayMs !== undefined) {
    transportConfig.retryBaseDelayMs = Math.max(0, Math.floor(config.retryBaseDelayMs))
  }
  if (config.logger !== undefined) {
    transportConfig.logger = config.logger ?? defaultTransportLogger
  }
}

function defaultTransportLogger(entry: ApiTransportLogEntry): void {
  if (entry.level === 'debug' || entry.level === 'info') return

  const method = entry.level === 'error' ? console.error : console.warn
  method('[GTG API]', {
    event: entry.event,
    functionName: entry.functionName,
    callerName: entry.callerName,
    attempt: entry.attempt,
    maxAttempts: entry.maxAttempts,
    elapsedMs: entry.elapsedMs,
    statusCode: entry.statusCode,
    code: entry.code,
    message: entry.message,
  })
}

function emitTransportLog(entry: ApiTransportLogEntry): void {
  transportConfig.logger(entry)
}

function assertFunctionName(functionName: string, callerName: string): void {
  if (!functionName || functionName.trim().length === 0) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): functionName is required.`,
      'VALIDATION_ERROR',
    )
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(functionName.trim())) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): functionName must be kebab-case.`,
      'VALIDATION_ERROR',
    )
  }
}

function assertJsonBody(
  body: Record<string, unknown>,
  callerName: string,
): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): body must be a JSON object.`,
      'VALIDATION_ERROR',
    )
  }
}

function assertHeaders(
  headers: Record<string, string>,
  callerName: string,
): void {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): headers must be an object.`,
      'VALIDATION_ERROR',
    )
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().length === 0 || value.trim().length === 0) {
      throw new ApiRequestError(
        `[GTG] ${callerName}(): headers cannot contain blank keys or values.`,
        'VALIDATION_ERROR',
      )
    }
  }
}

function extractStatusCode(error: unknown): number | undefined {
  const candidates: unknown[] = []

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    candidates.push(record['status'], record['statusCode'])

    const context = record['context']
    if (context && typeof context === 'object') {
      const contextRecord = context as Record<string, unknown>
      candidates.push(contextRecord['status'], contextRecord['statusCode'])

      const response = contextRecord['response']
      if (response && typeof response === 'object') {
        const responseRecord = response as Record<string, unknown>
        candidates.push(responseRecord['status'], responseRecord['statusCode'])
      }
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
  }

  return undefined
}

function normalizeInvokeError(error: unknown, functionName: string, callerName: string): ApiRequestError {
  if (error instanceof ApiRequestError) return error

  if (
    error instanceof Error &&
    error.name === 'AbortError'
  ) {
    return new ApiRequestError(
      `[GTG] ${callerName}(): ${functionName} request was aborted.`,
      'ABORTED',
    )
  }

  const message =
    error instanceof Error ? error.message : `Unknown error calling ${functionName}.`

  return new ApiRequestError(
    `[GTG] ${callerName}(): ${functionName} invocation failed: ${message}`,
    'FUNCTION_ERROR',
    extractStatusCode(error),
  )
}

function getRetryDelayMs(attempt: number): number {
  return transportConfig.retryBaseDelayMs * Math.max(1, 2 ** (attempt - 1))
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function invokeWithRetry<T>(
  functionName: string,
  callerName: string,
  options: InvokeFunctionOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = transportConfig.retryAttempts + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options?.signal?.aborted) {
      throw new ApiRequestError(
        `[GTG] ${callerName}(): ${functionName} request was aborted.`,
        'ABORTED',
      )
    }

    const startedAt = Date.now()

    emitTransportLog({
      level: 'debug',
      event: 'invoke_start',
      functionName,
      callerName,
      attempt,
      maxAttempts,
    })

    try {
      const result = await operation()

      emitTransportLog({
        level: 'info',
        event: 'invoke_success',
        functionName,
        callerName,
        attempt,
        maxAttempts,
        elapsedMs: Date.now() - startedAt,
      })

      return result
    } catch (error) {
      const normalized = normalizeInvokeError(error, functionName, callerName)
      const elapsedMs = Date.now() - startedAt

      if (normalized.code === 'ABORTED') {
        emitTransportLog({
          level: 'warn',
          event: 'invoke_failure',
          functionName,
          callerName,
          attempt,
          maxAttempts,
          elapsedMs,
          code: normalized.code,
          message: normalized.message,
        })

        throw normalized
      }

      if (attempt < maxAttempts && isTransientError(normalized)) {
        const delayMs = getRetryDelayMs(attempt)
        emitTransportLog({
          level: 'warn',
          event: 'invoke_retry',
          functionName,
          callerName,
          attempt,
          maxAttempts,
          elapsedMs,
          statusCode: normalized.statusCode,
          code: normalized.code,
          message: normalized.message,
        })
        await sleep(delayMs)
        continue
      }

      emitTransportLog({
        level: 'error',
        event: 'invoke_failure',
        functionName,
        callerName,
        attempt,
        maxAttempts,
        elapsedMs,
        statusCode: normalized.statusCode,
        code: normalized.code,
        message: normalized.message,
      })

      throw normalized
    }
  }

  throw new ApiRequestError(
    `[GTG] ${callerName}(): ${functionName} exhausted retry attempts.`,
    'FUNCTION_ERROR',
  )
}

function unwrapEnvelope<T>(
  data: FunctionEnvelope<T> | null,
  functionName: string,
  callerName: string,
): T {
  if (!data) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): ${functionName} returned an empty payload.`,
      'EMPTY_RESPONSE',
    )
  }

  if (data.error) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): ${data.error}`,
      'BUSINESS_ERROR',
    )
  }

  if (data.data === undefined) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): ${functionName} returned a payload with no data field.`,
      'MISSING_DATA',
    )
  }

  return data.data
}

// ─── getTableClient ───────────────────────────────────────────────────────────

/**
 * Returns the Supabase client for direct table reads.
 *
 * RULES:
 *   - Imported only from this file within @gtg/api — never from @gtg/supabase directly.
 *   - For READ operations only. All writes and financial mutations must go
 *     through invokeFunction* (Edge Functions).
 *   - RLS on the server enforces row-level access — this client does not
 *     bypass or replace that enforcement.
 */
export function getTableClient() {
  return getSupabaseClient()
}

// ─── invokeFunction ───────────────────────────────────────────────────────────

/**
 * Invoke a Supabase Edge Function and return the unwrapped result.
 *
 * Handles:
 *   - Auth: session JWT injected automatically by the Supabase client
 *   - Transport: routes through the configured Supabase project URL
 *   - Envelope: unwraps `{ data: T }` or throws on `{ error: string }`
 *   - Errors: all failures become ApiRequestError with a discriminable code
 *
 * @param functionName  Kebab-case Edge Function name (e.g. 'create-checkout-session')
 * @param body          JSON-serializable request payload
 * @param callerName    Calling TypeScript function name — used in error messages
 */
export async function invokeFunction<T>(
  functionName: string,
  body: Record<string, unknown>,
  callerName: string,
  options?: InvokeFunctionOptions,
): Promise<T> {
  assertFunctionName(functionName, callerName)
  assertJsonBody(body, callerName)

  return invokeWithRetry(functionName, callerName, options, async () => {
    const client = getSupabaseClient()

    const { data, error } = await client.functions.invoke<FunctionEnvelope<T>>(functionName, {
      body,
      signal: options?.signal,
    })

    if (error) {
      throw error
    }

    return unwrapEnvelope(data, functionName, callerName)
  })
}

// ─── invokeFunctionDirect ─────────────────────────────────────────────────────

/**
 * Invoke an Edge Function whose response is the result directly (no envelope).
 *
 * Use only when the Edge Function does not wrap its response in
 * `{ data: T }` — for example `process-order-ledger`, which returns
 * the pipeline result at the top level.
 *
 * @param functionName  Kebab-case Edge Function name
 * @param body          JSON-serializable request payload
 * @param callerName    Calling TypeScript function name
 */
export async function invokeFunctionDirect<T>(
  functionName: string,
  body: Record<string, unknown>,
  callerName: string,
  options?: InvokeFunctionOptions,
): Promise<T> {
  assertFunctionName(functionName, callerName)
  assertJsonBody(body, callerName)

  return invokeWithRetry(functionName, callerName, options, async () => {
    const client = getSupabaseClient()

    const { data, error } = await client.functions.invoke<T>(functionName, {
      body,
      signal: options?.signal,
    })

    if (error) {
      throw error
    }

    if (!data) {
      throw new ApiRequestError(
        `[GTG] ${callerName}(): ${functionName} returned an empty response.`,
        'EMPTY_RESPONSE',
      )
    }

    return data
  })
}

// ─── invokeFunctionMultipart ──────────────────────────────────────────────────

/**
 * Invoke an Edge Function with a multipart/form-data body.
 *
 * Use only when the Edge Function expects a file upload (e.g. `bulk-upload-units`).
 * FormData is constructed by the caller; this function handles the invocation
 * and error normalization.
 *
 * @param functionName  Kebab-case Edge Function name
 * @param formData      Pre-constructed FormData instance
 * @param callerName    Calling TypeScript function name
 */
export async function invokeFunctionMultipart<T>(
  functionName: string,
  formData: FormData,
  callerName: string,
  options?: InvokeFunctionOptions,
): Promise<T> {
  assertFunctionName(functionName, callerName)

  if (!(formData instanceof FormData)) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): formData must be a FormData instance.`,
      'VALIDATION_ERROR',
    )
  }

  return invokeWithRetry(functionName, callerName, options, async () => {
    const client = getSupabaseClient()

    const { data, error } = await client.functions.invoke<FunctionEnvelope<T>>(functionName, {
      body: formData,
      signal: options?.signal,
    })

    if (error) {
      throw error
    }

    return unwrapEnvelope(data, functionName, callerName)
  })
}

// ─── invokeFunctionWithHeaders ────────────────────────────────────────────────

/**
 * Invoke an Edge Function with custom request headers.
 *
 * Use only when the Edge Function requires non-default headers — for example
 * `export-royalty-csv`, which requires `Accept: text/csv` to receive a
 * raw CSV response instead of JSON.
 *
 * The response is returned as the raw type T. The caller is responsible
 * for decoding (e.g. calling `.text()` on a Blob).
 *
 * @param functionName  Kebab-case Edge Function name
 * @param body          JSON-serializable request payload
 * @param headers       Additional HTTP headers to include
 * @param callerName    Calling TypeScript function name
 */
export async function invokeFunctionWithHeaders<T>(
  functionName: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  callerName: string,
  options?: InvokeFunctionOptions,
): Promise<T> {
  assertFunctionName(functionName, callerName)
  assertJsonBody(body, callerName)
  assertHeaders(headers, callerName)

  return invokeWithRetry(functionName, callerName, options, async () => {
    const client = getSupabaseClient()

    const { data, error } = await client.functions.invoke<T>(functionName, {
      body,
      headers,
      signal: options?.signal,
    })

    if (error) {
      throw error
    }

    if (data === null || data === undefined) {
      throw new ApiRequestError(
        `[GTG] ${callerName}(): ${functionName} returned an empty response.`,
        'EMPTY_RESPONSE',
      )
    }

    return data
  })
}
