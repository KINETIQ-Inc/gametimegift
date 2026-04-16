-- =============================================================================
-- Migration: 20260415000200_checkout_idempotency_cache
--
-- Adds:
--   public.orders.checkout_idempotency_expires_at  TTL window for idempotent reuse
--   public.orders.checkout_response_cache          cached create-checkout-session response
-- =============================================================================

alter table public.orders
  add column if not exists checkout_idempotency_expires_at timestamptz,
  add column if not exists checkout_response_cache jsonb;

comment on column public.orders.checkout_idempotency_expires_at is
  'Expiration timestamp for checkout idempotency reuse. Requests with the same key reuse the cached response until this timestamp, then must create a new submission key.';

comment on column public.orders.checkout_response_cache is
  'Cached create-checkout-session success payload used to return the exact prior response for duplicate checkout submissions within the active idempotency TTL.';
