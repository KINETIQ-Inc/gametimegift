# ADR-0002: Apparel Variants as Sibling Products, and Phased Delivery Order

## Status
Accepted

## Context

The business needs t-shirts and hoodies with size (S/M/L/XL/2XL/3XL) and color options
alongside the existing collectible catalog. Every product today maps 1:1 to
`serialized_units` for hologram/serial tracking
(`packages/types/src/inventory.ts:56-100`) — each physical unit is individually
serialized and audited, including (per the compliance model already in place)
apparel, not just collectibles.

Two designs were considered for representing "one hoodie design, six sizes":

1. **A `product_variants` table** — one parent "design" row, many child variant
   rows underneath it, each variant carrying its own inventory/serial linkage.
2. **Sibling product rows sharing a `style_key`** — each size/color combination
   is its own full `products` row (own SKU, own serialized units, own price),
   grouped only by a shared `style_key` string.

## Decision

Model apparel variants as **sibling product rows sharing a `style_key`** (option
2). Every size and color is a first-class `products` row with its own SKU.

## Rationale

A real variant table would require either serializing inventory at the variant
level (a bigger, riskier restructuring of the compliance-critical hologram
model than this task calls for) or bolting a variant concept onto a schema that
assumes one row = one SKU = one audit trail throughout — every existing
constraint, trigger, and RLS policy on `products` was written against that
assumption. Sibling rows keep all of that working completely unchanged: apparel
products are just... products. The only new concept is `style_key` as a
grouping label, plus the columns needed to describe an apparel row
(`category`, `size`, `color` — see the Sprint 2 migration).

This also matches a convention already present in the codebase before this
work started: the SKU-naming doc comment in `create-product/index.ts` already
anticipated `APP-NIKE-JERSEY-M`-style SKUs with size baked into the string.

## The one rule this depends on

`style_key` must never become editable after creation (ADR-0001). If it did,
an admin could accidentally split a family of sizes apart or merge two
unrelated designs, orphaning inventory, ledger entries, and order history that
were denormalized against the SKU/style_key pairing at the time each row was
created. A future engineer who wants to "normalize this into a proper variants
table" should read ADR-0001 and ADR-0008 first — the sibling-rows design is
only safe because both immutability guarantees hold.

## Phasing

Implementation proceeds in five sprints, each with a distinct risk profile:

- **Sprint 1** — licensed-schools allowlist, vase hide toggle, admin school
  dropdown. No schema changes. Ships and deploys independently of everything
  below.
- **Sprint 2** — the apparel schema migration (category/size/color/style_key/
  lifecycle_status), plus types, `@gtg/domain` validators, and edge function
  changes. Gated on ADR-0001 through ADR-0009 existing as docs first.
- **Sprint 3** — admin UI for creating/editing apparel products.
- **Sprint 4** — storefront size/color picker for shoppers.
- **Sprint 5** — verification only (type-check, existing test suites, manual
  QA). No new features are introduced during Sprint 5.

## Consequences

- Apparel catalog management involves more individual product rows than a
  variant table would (one row per size × color), which is a deliberate
  trade-off for compliance-model safety, not an oversight.
- `list-products` and the storefront's product page need a "fetch siblings by
  style_key" query path (Sprint 2/4) since there's no parent row to join
  against.
