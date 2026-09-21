# ADR-0008: Serialized Unit Ownership Is Permanent

## Status
Accepted — documents an existing invariant; no code change required.

## Context

`SerializedUnit` maps 1:1 to a single `productId`/`sku` for its entire lifetime
(`packages/types/src/inventory.ts:56-100`). No move/reassign/merge function
exists anywhere in `packages/api/src/inventory.ts` or the
`bulk-upload-units`/`process-order-ledger` edge functions today — this is
already true of the codebase as it stands. This ADR exists to keep it true on
purpose, not by accident of what hasn't been built yet.

## Decision

A serialized unit belongs to exactly one SKU for its entire lifetime. Never:

- Move serialized inventory to another SKU.
- Merge serialized inventory from two SKUs.
- Reassign historical serialized units to a different product.

If a design changes materially, the correct action is always to create a new
product/SKU (and, for apparel, a new `style_key` — see ADR-0001) and receive
new serialized units against it. Existing units keep their original SKU
forever, sold or not.

## Rationale

Every ledger entry, fraud record, authenticity verification, and order line
depends on the unit-to-SKU relationship staying permanent. A "just reassign the
unit to the corrected SKU" feature request will look reasonable in isolation
(e.g. "we mislabeled a batch") but would silently invalidate historical
royalty calculations, commission records, and hologram verification lookups
that were computed against the original SKU at the time of sale.

## Consequences

- The correct fix for a genuine data-entry mistake (wrong product selected at
  receive time) is to void/return the affected units through the existing
  fraud-lock or return flow and re-receive correct units against the intended
  product — not to edit the existing units in place.
- This ADR is a fence against a plausible-looking future feature, not a
  response to anything currently broken.
