# ADR-0007: Product Lifecycle

## Status
Partially implemented — column added in Sprint 2; transition workflow reserved.

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

Scope for this task (Sprint 2): add a `lifecycle_status` enum column to
`products` (default `'ACTIVE'` for existing rows, so nothing has to be
re-migrated later) purely so the column exists. This does **not** build
transition-enforcement logic or admin UI for moving a product through the
states. `is_active` remains the sole operative "can this be ordered" flag until
that follow-up work happens.

Intended relationship once the workflow is built: `lifecycle_status = 'ACTIVE'`
implies `is_active = true`; every other status implies `is_active = false`.
This isn't enforced by a constraint yet — it's the design target for whoever
builds the transition workflow, so they aren't guessing at how the two fields
should relate.

## Rationale

Adding the column now, while the `products` table is already being migrated
for apparel support, is cheap and forward-compatible — no second migration
later just to add one enum column. Building the full transition-enforcement
logic and admin workflow now would be meaningfully more scope than this task
(apparel + licensed schools) calls for, and isn't blocking anything in Sprints
1-5.

## Consequences

- Until the workflow is built, `lifecycle_status` is present but not
  authoritative — don't build features that branch on it before the
  enforcement logic exists, or they'll be branching on a value nothing is
  actually maintaining yet beyond its default.
- The eventual workflow will need to decide who can move a product between
  states (likely admin-only, mirroring every other product mutation) and
  whether any transitions are one-way (e.g. `ARCHIVED` should probably never
  transition back to `ACTIVE` without going through `DRAFT` again).
