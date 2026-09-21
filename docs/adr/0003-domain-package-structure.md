# ADR-0003: `packages/domain` Is the Sole Home for Business Rules

## Status
Accepted

## Context

`packages/api/src/index.ts` already documents an IMPORT RULE: app code imports
from `@gtg/api` only, never from `@gtg/domain` directly, because `@gtg/domain`
holds business rules that are internal to the API package. This convention
predates this task (see `license.ts`, `commission.ts`, `fraud.ts`,
`hologram.ts`) but wasn't previously written down as its own decision, and one
existing violation was found during this work: `apps/storefront/src/referral-attribution.ts`
defined its own referral-code format regex locally instead of consuming it from
`@gtg/domain` through `@gtg/api`.

## Decision

`packages/domain` is the sole home for reusable business rules. It contains
pure domain logic only:

- No database access.
- No Supabase client.
- No HTTP calls.
- No UI.

Core structure (reached incrementally across this task's sprints):

```
packages/domain/src/
  license.ts             — existing: LicenseBody/ReportingPeriod validation, royalty math
  licensed-schools.ts     — Sprint 1: the CLC-licensed-schools allowlist
  consultant.ts           — Sprint 1: referral code format rules (moved from storefront app code)
  product-categories.ts   — Sprint 2: ProductCategory/ApparelSize validation
  apparel.ts              — Sprint 2: size ordering, garment types, style_key generation
  campaign.ts             — reserved stub (ADR-0004)
  bundle.ts               — reserved stub (ADR-0006)
  fulfillment.ts          — reserved stub (ADR-0009)
```

Every consumer (storefront, admin, edge functions) reaches this logic through
`@gtg/api`'s re-exports, never by importing `@gtg/domain` directly — apps and
edge functions are two different runtimes with two different access paths:

- **pnpm workspace apps** (`apps/storefront`, `apps/admin`, `apps/consultant`)
  go through `@gtg/api`.
- **Deno edge functions** (`supabase/functions/*`) can't import the pnpm
  package at all, so the specific validation logic they need is duplicated
  into `supabase/functions/_shared/`, each duplicate carrying an explicit
  `SYNC REQUIREMENT` comment pointing back at its `packages/domain` source —
  the same pattern already used for the `license_body` SQL enum staying in
  sync with the `LicenseBody` TypeScript union.

## Consequences

- The reservation stubs (`campaign.ts`, `bundle.ts`, `fulfillment.ts`) extend
  this package under the same "pure domain logic" constraint even though they
  have no runtime behavior yet — they're typed placeholders, not database
  access, so they don't violate the rule.
- Any future PR that adds a validation function directly inside a storefront/
  admin component, or inside an edge function, without a corresponding
  `packages/domain` (and `_shared/`, if server-side) source of truth should be
  treated as a bug against this ADR, not a style nitpick.
