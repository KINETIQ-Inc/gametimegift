# ADR-0006: Product Bundles as a First-Class Domain Object (Reserved)

## Status
Reserved — documented now, not implemented in this pass.

## Context

The "vases" category being hidden in Sprint 1 was, historically, a licensed
collectible paired with a flower arrangement — a bundle across two different
fulfillment paths (in-house serialized inventory + a floral partner). The
long-term product strategy pairs licensed products (vases historically,
apparel going forward) with fulfillment-partner add-ons. Nothing in the current
schema represents "these products are sold together as one offering."

## Existing related code

`packages/api/src/bundles.ts` already exists — a client-side "bundle offer"
scaffolding module (`BundleOffer`, `BundleReadyState: 'concept' | 'scaffolded' | 'live'`,
`buildProductBundleScaffold`) for pitching partner bundle ideas (floral,
corporate, concierge, gift_box) around an anchor product. It has **no backing
database table** and is not referenced by orders or inventory — it's a
planning/pitch-stage tool, not a transactable entity. The `Bundle` reserved
below is the DB-backed evolution of that same idea once a bundle is ready to
actually sell, not a competing concept: a `ready_state: 'live'` bundle offer
is what would eventually get persisted as a real `Bundle` row.

## Decision

Reserve a `Bundle` domain object:

- A bundle references component products/SKUs.
- An order line points to a bundle when applicable.
- Inventory, royalties, and serialized-unit tracking continue to operate at the
  **individual product level** — a bundle is a sales/fulfillment wrapper, never
  a compliance/inventory unit itself. Each component product keeps its own
  serialized units, hologram, royalty rate, and audit trail exactly as it would
  if sold standalone.
- Each bundle component is designed so it can eventually name a fulfillment
  partner (ADR-0009) without building that assignment logic now — e.g. the
  collectible component ships from internal fulfillment, the floral component
  ships from a floral partner, under one customer-facing bundle.

`packages/domain/src/bundle.ts` gets a type-only stub now (`Bundle`,
`BundleComponentLink`) pointing at this ADR. No runtime logic yet.

## Rationale

Keeping bundles as a wrapper — rather than teaching `products` or
`serialized_units` about multi-vendor composition directly — preserves every
compliance guarantee already built around individual products (SKU
immutability, hologram-per-unit, royalty calculation) without exception
handling for "unless it's part of a bundle." The bundle is purely a commercial
and fulfillment grouping.

## Consequences

- When built, an order line referencing a bundle will need to resolve to
  multiple fulfillment instructions (one per component), which is a
  fulfillment/shipping concern, not an inventory or royalty concern.
- This is explicitly not part of Sprints 1-5. It's recorded now so the apparel
  work in this task doesn't accidentally foreclose it (e.g. by hard-coding an
  assumption that every order line maps to exactly one product with no
  possibility of a bundle wrapper above it).
