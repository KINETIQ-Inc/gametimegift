/**
 * Typed error class for all @gtg/api failures.
 *
 * Every function in this package throws ApiRequestError on failure —
 * never a plain Error, never a string. This gives app code a single
 * catch type with a discriminable code field.
 *
 * @example
 * ```ts
 * import { ApiRequestError } from '@gtg/api'
 *
 * try {
 *   const result = await submitOrder({ orderId })
 * } catch (err) {
 *   if (err instanceof ApiRequestError) {
 *     switch (err.code) {
 *       case 'FUNCTION_ERROR':   // edge function returned an HTTP error
 *       case 'BUSINESS_ERROR':   // edge function returned { error: string }
 *       case 'EMPTY_RESPONSE':   // edge function returned null data
 *       case 'VALIDATION_ERROR': // client-side input guard rejected the call
 *     }
 *   }
 * }
 * ```
 */

// ─── Error Codes ──────────────────────────────────────────────────────────────

/**
 * Discriminable error codes thrown by @gtg/api functions.
 *
 *   VALIDATION_ERROR   — Client-side input guard failed (bad UUID, blank field, etc.)
 *   FUNCTION_ERROR     — Edge function invocation failed at the transport level
 *                        (network error, HTTP 4xx/5xx from the function host)
 *   BUSINESS_ERROR     — Edge function returned { error: string } in its payload
 *                        (a domain rule violation enforced server-side)
 *   EMPTY_RESPONSE     — Edge function returned null/undefined data (no body)
 *   MISSING_DATA       — Edge function envelope was present but data field was absent
 *   QUERY_ERROR        — Direct Supabase table query returned an error
 */
export type ApiErrorCode =
  | 'ABORTED'
  | 'VALIDATION_ERROR'
  | 'FUNCTION_ERROR'
  | 'BUSINESS_ERROR'
  | 'EMPTY_RESPONSE'
  | 'MISSING_DATA'
  | 'QUERY_ERROR'

// ─── ApiRequestError ──────────────────────────────────────────────────────────

/**
 * The single error type thrown by all @gtg/api functions.
 *
 * Catch this in app code to handle API failures without switching on string
 * message content. The `code` field is the stable discriminant; `message`
 * is a human-readable description for logging.
 *
 * `statusCode` is the HTTP status from the edge function when available,
 * or undefined for client-side validation errors.
 */
export class ApiRequestError extends Error {
  /** Stable discriminant — safe to switch on in application code. */
  readonly code: ApiErrorCode
  /**
   * HTTP status code from the edge function host, when applicable.
   * Undefined for VALIDATION_ERROR and client-side QUERY_ERROR.
   */
  readonly statusCode: number | undefined

  constructor(message: string, code: ApiErrorCode, statusCode?: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.statusCode = statusCode
    // Restore prototype chain in compiled output
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Returns true if the error represents a transient failure that is safe to retry.
 *
 * Transient failures:
 *   - Network error  (FUNCTION_ERROR with no statusCode — request never reached the host)
 *   - Server error   (FUNCTION_ERROR with 5xx statusCode)
 *   - Rate limit     (FUNCTION_ERROR with 429 statusCode)
 *
 * Non-transient failures — retrying will not help:
 *   - VALIDATION_ERROR  — bad client input; user must fix the form
 *   - BUSINESS_ERROR    — domain rule violation (e.g. duplicate SKU)
 *   - 4xx (excl. 429)  — auth or bad request; won't resolve on retry
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false
  if (error.code === 'ABORTED') return false
  if (error.code !== 'FUNCTION_ERROR') return false
  const s = error.statusCode
  return s === undefined || s === 429 || s >= 500
}

/**
 * Returns true if the error indicates the request was unauthorized (401)
 * or the authenticated user lacks permission (403).
 */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false
  return (
    error.code === 'FUNCTION_ERROR' &&
    (error.statusCode === 401 || error.statusCode === 403)
  )
}

/**
 * Returns true if the error is a rate-limit response (HTTP 429).
 * The caller should back off before retrying.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false
  return error.code === 'FUNCTION_ERROR' && error.statusCode === 429
}

// ─── User-Facing Message ──────────────────────────────────────────────────────

/**
 * Translate any thrown value into a clean user-facing message.
 *
 * Maps structural error codes and HTTP status codes to human-readable copy.
 * Strips the internal `[GTG] functionName(): ` prefix from VALIDATION_ERROR
 * and BUSINESS_ERROR messages so the domain detail reaches the user without
 * internal implementation noise.
 *
 * Priority: auth → rate-limit → network → server → domain/validation → fallback.
 *
 * @param error    The caught value — ApiRequestError, Error, or unknown.
 * @param fallback Message to return when the error cannot be categorised.
 */
export function toUserMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'ABORTED') {
      return 'Checkout took too long to start. Please try again.'
    }
    if (error.statusCode === 401) {
      return 'Your session has expired. Please reload the page and sign in again.'
    }
    if (error.statusCode === 403) {
      return 'You do not have permission to perform this action.'
    }
    if (error.statusCode === 429) {
      return 'Too many requests. Please wait a moment and try again.'
    }
    if (error.code === 'FUNCTION_ERROR' && error.statusCode === undefined) {
      return 'Unable to reach the server. Check your connection and try again.'
    }
    if (
      error.code === 'FUNCTION_ERROR' &&
      error.statusCode !== undefined &&
      error.statusCode >= 500
    ) {
      return 'A server error occurred. Please try again in a moment.'
    }
    // BUSINESS_ERROR / VALIDATION_ERROR: strip "[GTG] functionName(): " prefix
    const stripped = error.message.replace(/^\[GTG\]\s+[\w.]+\(\):\s*/, '')
    return stripped.length > 0 ? stripped : fallback
  }

  if (error instanceof Error) return error.message
  return fallback
}

// ─── normalizeError ───────────────────────────────────────────────────────────

/**
 * Convert any thrown value into an ApiRequestError and re-throw.
 *
 * Use this in catch blocks when you need to normalize unknown errors
 * (e.g. Supabase SDK errors) into the standard ApiRequestError type.
 * Already-typed ApiRequestErrors pass through unchanged.
 */
export function normalizeError(err: unknown, callerName: string): never {
  if (err instanceof ApiRequestError) throw err
  const message = err instanceof Error ? err.message : String(err)
  throw new ApiRequestError(
    `[GTG] ${callerName}(): ${message}`,
    'QUERY_ERROR',
  )
}
