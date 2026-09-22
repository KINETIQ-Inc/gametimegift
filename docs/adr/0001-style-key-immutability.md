# ADR-0001: `style_key` Is Immutable and System-Generated

## Status
Accepted

## Context

Apparel products (t-shirts, hoodies) need size and color variants. The existing
`products` schema has no variant concept — every product today is a single flat
row: one SKU, one price, one `license_body`. Variants are modeled as sibling
product rows that share a `style_key` (e.g. `APP-CLEMSON-HOODIE`), with the full
SKU appending size (`APP-CLEMSON-HOODIE-M`). See ADR-0002 for why this pattern
was chosen over a separate variants table.

`style_key` therefore plays the same role `sku` already plays for a single
product: a stable key that other records (serialized units, order lines, ledger
entries) can be denormalized against without fear of it moving underneath them.

## Decision

1. **`style_key` is immutable once a product exists.** No API path may change it
   after creation — not `edit-product`, not any future admin tool. This is
   enforced at the database level with a trigger (`prevent_style_key_update()`),
   mirroring the existing `prevent_sku_update()` trigger
   (`supabase/migrations/20260305000001_create_products.sql:130-151`) exactly.
   A materially different design (new artwork, manufacturer, garment) gets a new
   `style_key`, never a mutation of an existing one.
2. **`sku` remains immutable**, as it already is today — unaffected by this ADR,
   restated here because the two rules are related and both matter for apparel.
3. **`style_key` is system-generated, not admin-invented.** Admins never type a
   `style_key` by hand (no "Red Hoodie"-style free text, which invites drift and
   typos). It is derived deterministically from School + Garment Type via
   `generateStyleKey(schoolCode, garmentType)` →
   `APP-${schoolCode}-${garmentType}`, using the short codes in
   `packages/domain/src/licensed-schools.ts` (`LICENSED_SCHOOL_CODES`) and the
   garment types in `packages/domain/src/apparel.ts` (`GARMENT_TYPES`).
   `create-product` computes it server-side; it is never accepted as a
   client-supplied field. `edit-product`'s patchable-fields list omits
   `style_key` entirely — not just discouraged, structurally absent from what
   can be submitted.

## Rationale

Serialized inventory, hologram tracking, order history, and audit records all
key off `sku`/`style_key` (see ADR-0008, Serialized Unit Ownership). Allowing
either to change after creation would let a size or color group split apart or
merge with another one from under existing inventory, orphaning the
relationship between a serialized unit and the design it was actually
manufactured as. A generator eliminates the free-text failure mode by
construction — there is no "did the admin type this consistently across five
sizes" question to get wrong.

## Consequences

- A future "let's normalize this into a proper `product_variants` table"
  refactor must preserve this guarantee — style_key based grouping is *why* the
  sibling-rows approach in ADR-0002 is safe. Read that ADR before changing this
  one.
- Admin UI (Sprint 3) computes and displays `style_key` as a live preview during
  creation, and as read-only text once a product exists — never an editable
  input.
