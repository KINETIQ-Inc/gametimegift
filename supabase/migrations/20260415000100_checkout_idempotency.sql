-- =============================================================================
-- Migration: 20260415000100_checkout_idempotency
--
-- Adds:
--   public.orders.checkout_idempotency_key  stable dedupe key per checkout attempt
--   public.orders.checkout_session_id       Stripe Checkout Session id for safe retry reuse
-- =============================================================================

alter table public.orders
  add column if not exists checkout_idempotency_key text,
  add column if not exists checkout_session_id text;

create unique index if not exists orders_checkout_idempotency_key_unique
  on public.orders (checkout_idempotency_key)
  where checkout_idempotency_key is not null;

create unique index if not exists orders_checkout_session_id_unique
  on public.orders (checkout_session_id)
  where checkout_session_id is not null;

comment on column public.orders.checkout_idempotency_key is
  'Client-generated idempotency key for a storefront checkout attempt. Reused to safely resume the same pending payment session.';

comment on column public.orders.checkout_session_id is
  'Stripe Checkout Session id (cs_*) created for the pending payment flow. Stored so duplicate submits can return the existing session instead of creating a second order.';
