# ADR-0005: Referral Attribution Designed for Day One

## Status
Reserved — documented now; existing fields unchanged in this pass.

## Context

`apps/storefront/src/referral-attribution.ts` already implements consultant
referral capture (`?ref=CODE` in the URL, localStorage persistence, format
validation — now sourced from `@gtg/domain` per ADR-0003). Orders already carry
`consultant_id`/`consultant_name`
(`supabase/migrations/20260305000006_create_orders.sql:91-94`, enforced by the
`orders_consultant_channel_consistent` check constraint) and `discount_code`.
There is no `campaign_id` or UTM-style column on `orders` today.

## Decision

Orders should eventually be able to carry, even where optional/null today:

| Field | Status today |
|---|---|
| Consultant ID | Exists (`orders.consultant_id`) |
| Referral Code | Exists client-side (localStorage); **not persisted on the order row** |
| Campaign ID | Reserved (ADR-0004) |
| Marketing Source | Reserved |
| Marketing Medium | Reserved |
| Marketing Campaign | Reserved (the standard UTM triad: source/medium/campaign) |

The intended future `orders` columns:

```sql
campaign_id       uuid references campaigns(id)
referral_code     text
marketing_source  text
marketing_medium  text
marketing_campaign text
```

None of these are migrated in this pass — this ADR documents the target so the
eventual migration doesn't have to be re-derived, and so nobody assumes
`consultant_id` alone is "attribution" when campaign and marketing-source
attribution are also coming.

## Rationale

Commission accuracy, campaign analytics (once ADR-0004 is built), and customer
acquisition reporting all depend on knowing not just *who* referred an order,
but *which campaign* and *which marketing channel* drove it. Capturing this
relationship early — even as reserved, nullable columns — avoids a schema
redesign later; retrofitting attribution onto years of existing order history
is much harder than reserving the columns now and backfilling them as the
campaign/marketing tooling comes online.

## Consequences

- `referral_code` is not yet written to the `orders` table even though it's
  already captured client-side — a future migration should decide whether to
  persist the raw code, the resolved `consultant_id` only, or both.
- Building the UTM triad requires deciding where marketing-source capture
  happens (likely the same `referral-attribution.ts` capture path, extended to
  read `utm_source`/`utm_medium`/`utm_campaign` alongside `?ref=`) — reserved,
  not designed in detail here.
