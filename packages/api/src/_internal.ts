/**
 * @internal
 * Shared primitives for @gtg/api modules.
 *
 * NOT exported from the package index — for internal module use only.
 * All modules in this package import from here instead of copy-pasting.
 *
 * Edge function invocations should use transport.ts (invokeFunction).
 * This module provides the wire-format type and validation utilities used
 * by both transport.ts and domain modules that perform direct table reads.
 */

import { ApiRequestError } from './error'

// ─── Wire Format ─────────────────────────────────────────────────────────────

/**
 * Standard response envelope returned by all GTG Edge Functions.
 *
 * Edge Functions wrap their payload as `{ data: T }` on success
 * or `{ error: string }` on failure.
 *
 * Prefer invokeFunction() from transport.ts over unwrapping manually.
 */
export type FunctionEnvelope<T> = {
  data?: T
  error?: string
}

/**
 * Unwrap a FunctionEnvelope<T>.
 *
 * Used internally by transport.ts. Domain modules should call invokeFunction()
 * rather than invoking this directly.
 *
 * Throws ApiRequestError for:
 *   - null/undefined payload (EMPTY_RESPONSE)
 *   - envelope-level error string (BUSINESS_ERROR)
 *   - missing data field (MISSING_DATA)
 */
export function unwrapFunctionEnvelope<T>(payload: FunctionEnvelope<T> | null, fnName: string): T {
  if (!payload) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): function returned an empty payload.`,
      'EMPTY_RESPONSE',
    )
  }
  if (payload.error) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): ${payload.error}`,
      'BUSINESS_ERROR',
    )
  }
  if (payload.data === undefined) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): missing data in function payload.`,
      'MISSING_DATA',
    )
  }
  return payload.data
}

// ─── Validation ───────────────────────────────────────────────────────────────

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Assert that a value is a UUID v4.
 *
 * Throws ApiRequestError (VALIDATION_ERROR) if the value does not match.
 *
 * @param value     The string to validate.
 * @param fieldName The field name used in the error message (e.g. `'orderId'`).
 * @param fnName    The calling function name used in the [GTG] prefix.
 */
export function assertUuidV4(value: string, fieldName: string, fnName: string): void {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): ${fieldName} must be a valid UUID v4.`,
      'VALIDATION_ERROR',
    )
  }
}
