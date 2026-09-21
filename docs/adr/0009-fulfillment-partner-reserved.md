# ADR-0009: Fulfillment Partner (Reserved, Not Built)

## Status
Reserved — documented now, not implemented in this pass.

## Context

Today every product implicitly assumes a single, unstated fulfillment path.
The business's actual direction includes multiple eventual fulfillment
partners: internal fulfillment, a floral partner (relevant to ADR-0006's
bundle reservation), print-on-demand apparel, and a warehouse partner. Nothing
in the architecture should assume there will only ever be one.

## Decision

Reserve a `FulfillmentPartner` concept:

- `packages/domain/src/fulfillment.ts` gets a type-only stub
  (`FulfillmentPartner`, `FulfillmentAssignment`) pointing at this ADR. No
  runtime logic, no schema, nothing wired into `@gtg/api` yet.
- Bundle component links (ADR-0006) are designed so each component can
  eventually name a fulfillment partner — this is a design constraint on that
  ADR, not new work here.
- Nothing in Sprint 2's apparel schema should hard-code an assumption of a
  single fulfillment path (e.g. no `fulfillment_method` boolean, no
  "internal vs. external" binary flag) — if apparel fulfillment needs to be
  distinguished from collectible fulfillment later, it should be expressible
  as "a different `FulfillmentPartner`," not a special case bolted onto
  `products`.

## Rationale

Print-on-demand apparel in particular is a plausible near-term need (different
lead time, different vendor, possibly no serialized-unit-per-item model at
all) — reserving the concept now means that if/when it arrives, it's "add a
fulfillment partner," not "redesign how apparel orders are fulfilled."

## Consequences

- This is explicitly not part of Sprints 1-5. Apparel in this task still
  fulfills the same way collectibles do (serialized units, internal
  fulfillment) — the reservation is about not closing the door on that
  changing later, not about building multi-partner fulfillment now.
