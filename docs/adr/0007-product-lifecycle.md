# ADR-0007: Product Lifecycle

## Status
Integrity relationship implemented; ordered transition workflow reserved.

## Context

GTG is a licensed company. Products don't simply disappear: a license expires,
artwork or garment specs change, or inventory sells out permanently. The
business needs that history preserved without deleting the row (deletion is
already prohibited for `products` — see
`supabase/migrations/20260305000001_create_products.sql:213-215`). Today the
only lifecycle signal is the boolean `is_active` flag, which can't distinguish
"still being drafted," "sold out but keep the record," or "actively for sale."

## Decision

Target state machine:

```
DRAFT → READY_FOR_REVIEW → ACTIVE → DISCONTINUED → ARCHIVED
```

Sprint 2 added a `lifecycle_status` enum column to `products` with an `ACTIVE`
default. The follow-up integrity migration makes the relationship between that
column and the operative publication flag explicit:

`lifecycle_status = 'ACTIVE'` if and only if `is_active = true`; every other
status requires `is_active = false`. The database constraint is authoritative,
and `edit-product` keeps the two fields synchronized when a caller supplies
only one. Ordered transition authorization remains future work.

## Rationale

Adding the column now, while the `products` table is already being migrated
for apparel support, is cheap and forward-compatible — no second migration
later just to add one enum column. Building the full transition-enforcement
logic and admin workflow now would be meaningfully more scope than this task
(apparel + licensed schools) calls for, and isn't blocking anything in Sprints
1-5.

## Consequences

- `lifecycle_status` and `is_active` cannot contradict one another. Existing
  rows are reconciled before the database constraint is installed.
- The eventual workflow will need to decide who can move a product between
  states (likely admin-only, mirroring every other product mutation) and
  whether any transitions are one-way (e.g. `ARCHIVED` should probably never
  transition back to `ACTIVE` without going through `DRAFT` again).
