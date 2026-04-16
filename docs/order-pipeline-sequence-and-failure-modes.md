# Order Pipeline Sequence and Failure Modes

This is the Phase 7A-2 documentation for the order pipeline.

## Canonical Pipeline

Primary orchestrator: `supabase/functions/process-order-ledger/index.ts`

Step sequence:

1. `validate-order`
2. `reserve-inventory` (validate serialized units)
3. `record-ledger` (inventory ledger entries)
4. `compute-commission`
5. `apply-royalty`
6. `finalize-order` (stable response shape)

The orchestrator preserves stable response contract via `buildProcessResponse(...)` in `contracts.ts`.

## Step Contracts

Each module returns `ok: true | false`, plus:

- `steps`: normalized step records for observability.
- `status`: mapped HTTP status on failure (`422` precondition/business failures, `500` execution/internal failures).
- `errors`: normalized validation error list.

Error normalization source:

- `supabase/functions/process-order-ledger/error-model.ts`

## Failure Modes by Step

### 1) Validate order

- Invalid/missing `order_id` input.
- Order lookup/validation failures.
- Authentication/authorization failures for non-internal calls.
- Internal webhook path missing required env (`GTG_SERVICE_ACCOUNT_ID`, service-role mismatch).

### 2) Reserve inventory

- Unit missing for order line.
- Serial mismatch between order line and serialized unit.
- Unit status not sellable.
- Unit reserved for another order.
- Missing/incomplete hologram metadata.
- Invalid `cost_cents` / `royalty_rate`.
- Active fraud flags blocking sale.

### 3) Record ledger

- `sell_unit` RPC errors per order line.
- Missing ledger entry IDs from RPC payload.
- Partial inserts across lines (reported with error_count and per-line errors).

### 4) Compute commission

- Consultant missing/ineligible for commission path.
- Missing tier config or invalid custom rate setup.
- No commissionable order lines.
- Commission entry RPC failures (`create_commission_entry`).
- Partial commission entry creation.

### 5) Apply royalty

- Missing active license holder configuration.
- Royalty rate mismatches / invalid preconditions.
- Royalty computation failures.
- Royalty insert RPC failures (`create_royalty_entry`).
- Partial royalty insert creation.

### 6) Finalize

- Returns success or failure envelope without changing API shape.
- Includes ordered step results and normalized errors for caller/UI diagnostics.

## Pipeline Safety Properties

- Step-local failures short-circuit downstream steps.
- Internal + admin invocation paths are explicit and separated.
- Error model is unified across modules.
- Response shape remains backward compatible through the refactor.
