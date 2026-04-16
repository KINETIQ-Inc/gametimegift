# Release Checklist: Schema and Function Compatibility

This is the Phase 7B-2 release checklist for DB schema, SQL RPC, edge functions, and app compatibility.

## Pre-Release Checks

1. Pull latest migrations and confirm migration order is linear and committed.
2. Validate env contract:
   - `pnpm config:validate`
3. Regenerate function surface docs:
   - `pnpm surface:generate`
4. Run CI-equivalent checks locally:
   - `pnpm test:ci`

## Schema/RPC Compatibility

1. For every changed edge function query:
   - Confirm referenced tables/columns exist in current migration set.
   - Confirm renamed columns/tables are fully updated in all call sites.
2. For every changed RPC invocation:
   - Confirm SQL function name/signature matches function call payload.
   - Confirm return shape assumptions are still valid.
3. Validate constraints and state-machine compatibility:
   - unit status transitions
   - order status transitions
   - immutable ledger protections

## Auth/RLS Compatibility

1. Confirm role gating still matches endpoint contract (`public/authenticated/admin/internal/scheduled`).
2. Confirm RLS behavior for user-client reads remains expected.
3. Confirm admin-client usage is only behind explicit authz checks.

## Order Pipeline Safety

1. Confirm `process-order-ledger` response shape remains stable.
2. Confirm modular steps still run in canonical sequence.
3. Confirm failure mapping still uses normalized error model and expected HTTP statuses.

## Deployment Gates

1. CI must pass:
   - type-check
   - lint
   - unit/integration tests
   - storefront UI smoke test
   - critical test gate
   - config validation
2. No unresolved dead-endpoint removals without owner confirmation.

## Release Execution

1. Apply migrations.
2. Deploy edge functions.
3. Deploy apps/packages.
4. Run smoke verification:
   - storefront serial verification flow
   - checkout initiation
   - admin critical read/write path

## Post-Release Verification

1. Monitor function errors and latency for 30-60 minutes.
2. Spot-check one new order end-to-end:
   - order row
   - order lines
   - inventory ledger
   - commission (if consultant-assisted)
   - royalty (if licensed)
3. Confirm no unexpected increase in fraud/lock incident alerts.
