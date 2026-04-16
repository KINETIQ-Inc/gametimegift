export interface ExistingOrderRow {
  id: string
  order_number: string
  status: string
  customer_email: string
  checkout_idempotency_key: string | null
  checkout_idempotency_expires_at: string | null
  checkout_response_cache: Record<string, unknown> | null
  checkout_session_id: string | null
}

export type IdempotencyResolution =
  | { kind: 'expired' }
  | { kind: 'return_cached'; cachedResponse: Record<string, unknown> }
  | { kind: 'reject_processed' }
  | { kind: 'resume_pending' }

export function isActiveIdempotencyWindow(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false

  const parsed = Date.parse(expiresAt)
  if (!Number.isFinite(parsed)) {
    return false
  }

  return parsed > now
}

export function resolveExistingOrderIdempotency(
  existing: ExistingOrderRow,
  now = Date.now(),
): IdempotencyResolution {
  const withinTtl = isActiveIdempotencyWindow(existing.checkout_idempotency_expires_at, now)

  if (!withinTtl) {
    return { kind: 'expired' }
  }

  if (existing.checkout_response_cache) {
    return {
      kind: 'return_cached',
      cachedResponse: existing.checkout_response_cache,
    }
  }

  if (existing.status !== 'pending_payment' || !existing.checkout_session_id) {
    return { kind: 'reject_processed' }
  }

  return { kind: 'resume_pending' }
}
