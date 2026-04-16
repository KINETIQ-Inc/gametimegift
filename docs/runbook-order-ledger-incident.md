# Incident Runbook: Order/Ledger Failures

This is the Phase 7B-1 runbook for order pipeline and ledger incidents.

## Trigger Conditions

Open incident when any of the following is observed:

- Checkout succeeds but order is missing or incomplete.
- `process-order-ledger` returns `success: false` or repeated 5xx.
- Missing or partial inventory/commission/royalty ledger entries.
- Duplicate sale signals or lock/fraud escalation anomalies.

## Severity Guide

- `SEV-1`: Active revenue-impacting outage, broad checkout/order failures.
- `SEV-2`: Partial degradation, retries possible, limited blast radius.
- `SEV-3`: Single-order data mismatch, manual remediation possible.

## Immediate Actions (First 15 Minutes)

1. Acknowledge incident and assign incident commander.
2. Freeze risky admin write operations (bulk unit edits, mass payout actions).
3. Capture failing identifiers:
   - `order_id`
   - `payment_intent_id` / checkout session ID
   - affected `unit_id` / serials
   - consultant_id (if applicable)
4. Confirm function health:
   - `stripe-webhook`
   - `process-order-ledger`
   - `validate-order`
   - `validate-serialized-units`

## Triage Checklist

1. Verify Stripe webhook intake:
   - Event persisted to `payment_events`.
   - Signature verification and status transitions are healthy.
2. Verify order materialization:
   - `orders` row exists.
   - `order_lines` row count matches expected purchased quantity.
3. Verify inventory ledger integrity:
   - `inventory_ledger_entries` contains sale entries for each non-cancelled line.
4. Verify commission integrity:
   - `commission_entries` created for eligible consultant-assisted flow.
   - status (`earned` / `held`) matches tax onboarding state.
5. Verify royalty integrity:
   - `royalty_entries` created for licensed items with valid holder config.
6. Check lock/fraud blockers:
   - `fraud_flags` active statuses.
   - `lock_records` active locks preventing sale transitions.

## Containment

- If issue is ongoing in code path, disable triggering action in admin UI/workflow.
- If issue is data-driven (bad config), correct configuration first:
  - commission tier config
  - license holder active rates
  - malformed serialized unit/hologram data
- For repeated transient failure, retry single order processing only after root condition is fixed.

## Recovery

1. Re-run or manually remediate failed order in controlled sequence:
   - validate order
   - validate units
   - create missing inventory ledger entries
   - create missing commission entries
   - create missing royalty entries
2. Confirm idempotency outcomes:
   - no duplicate ledger rows
   - no duplicate commission/royalty rows
3. Validate customer-facing outcome:
   - order status correct
   - serial ownership/state consistent

## Communication

- Update cadence:
  - `SEV-1`: every 15 minutes
  - `SEV-2`: every 30 minutes
  - `SEV-3`: hourly
- Stakeholders:
  - Commerce/Payments
  - Inventory Ops
  - Finance Ops
  - Support (for customer impact)

## Exit Criteria

- New orders process successfully end-to-end.
- Backlog of failed orders remediated or queued with owner/date.
- Root cause documented with permanent fix task created.

## Postmortem Requirements

- Root cause and contributing factors.
- Why safeguards/tests did not catch issue.
- Preventive actions:
  - test coverage additions
  - alerting/observability additions
  - config validation improvements
