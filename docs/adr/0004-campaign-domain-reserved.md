# ADR-0004: Campaign Domain (Reserved, Not Built)

## Status
Reserved — documented now, not implemented in this pass.

## Context

The business is moving toward seasonal campaigns (Mother's Day, Graduation,
Homecoming, Veterans Day, Christmas) as first-class merchandising events, not
just ad hoc discount codes. `packages/api/src/campaign.ts` already exists as a
documented contract for a promotional discount-code "Campaign"
(`Campaign`, `createCampaign`, `validateDiscountCode`, `discount_code` on
`orders`) — but its own doc comment says the backing `campaigns` table is only
"specified here first as the contract," and no `campaigns` table migration
exists yet (confirmed by grep across `supabase/migrations/`).

## Decision

Extend this existing (schema-less) `Campaign` concept rather than invent a
second, competing one. When campaign work is actually built, it should grow
into:

- **`campaigns`** — the existing `Campaign` type, extended with a season/theme
  identity (Mother's Day, Graduation, Homecoming, Veterans Day, Christmas), not
  just a discount code.
- **`campaign_products`** — join table: which SKUs are featured in / exclusive
  to a campaign.
- **`campaign_consultants`** — join table: which consultants are assigned to /
  participating in a campaign.
- **`campaign_performance`** — reporting rollup of a campaign's results
  (units sold, revenue, commission paid).
- **`campaign_orders`** — the orders attributed to a campaign (see ADR-0005 for
  the `orders.campaign_id` column this implies).

`packages/domain/src/campaign.ts` gets a type-only stub now
(`SeasonalCampaign`, `CampaignProductLink`, `CampaignConsultantLink`) pointing
at this ADR. No runtime logic, no export from `@gtg/api` yet — there's nothing
to validate without a schema behind it.

## Rationale

Reserving the shape now — even without building it — means the eventual
migration doesn't have to be designed from scratch under deadline pressure, and
nobody accidentally builds a second, incompatible "campaign" concept in the
meantime because the existing `campaign.ts` API contract wasn't visible or
understood.

## Consequences

- Building this for real is a distinct, larger effort than this task's scope
  (apparel + licensed schools). It is explicitly not part of Sprints 1-5.
- When it is built, `orders.discount_code` likely becomes derived from the
  campaign rather than a freestanding field — that migration should account for
  existing orders that already carry a `discount_code`.
