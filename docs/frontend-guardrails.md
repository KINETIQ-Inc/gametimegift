# Frontend Guardrails

## Phase A

Goal: stop UI drift before more screens are built.

## Findings flagged

- Duplicate checkout flows existed in storefront:
  - dedicated page: `apps/storefront/src/pages/CheckoutPage.tsx`
  - modal checkout: `apps/storefront/src/components/checkout/CheckoutPanel.tsx`
- Checkout state had been scattered across page components and `StorefrontContext`.
- Component consistency was drifting:
  - checkout existed in both page and modal form
  - app auth used raw client methods instead of package-level wrappers
- App auth flows were calling the raw Supabase client surface through `getClient()`.

## Rules now enforced

- One checkout entry point only:
  - all purchase actions route to `/checkout`
  - `CheckoutPage` is the only UI surface allowed to call `createOrder()`
- No direct Supabase imports in app code:
  - apps must not import `@gtg/supabase`
  - apps must not import `@supabase/supabase-js`
- No internal package imports in app code:
  - apps must not import `@gtg/api/src/*`
- UI must call package wrappers:
  - storefront / consultant / admin use `@gtg/api`
  - auth session behavior goes through `packages/api/src/auth.ts`

## Implementation notes

- Modal checkout removed from storefront.
- Product detail `Buy Now` now navigates to the dedicated checkout route.
- Consultant and admin auth providers now use `@gtg/api` auth wrappers instead of raw client calls.
- ESLint blocks future regressions at the app layer.
