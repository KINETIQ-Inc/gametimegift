# Endpoint Auth and Role Matrix

This is the Phase 7A-3 auth/role matrix for the full edge-function surface (52 endpoints).

## Role Sets

- `ADMIN_ROLES`: `super_admin`, `admin`
- `REPORTING_ROLES`: `super_admin`, `admin`, `licensor_auditor`
- `ALL_ROLES`: any authenticated GTG role

## Exposure Classes

### Public (2)

No JWT required.

- `get-fraud-warning`
- `verify-serial`

### Authenticated (12)

JWT required; access policy varies by endpoint.

Policy A: `ALL_ROLES` (any authenticated user)

- `check-availability`
- `create-checkout-session`
- `list-products`
- `validate-order`

Policy B: admin or consultant with self-scope enforcement

- `commission-summary`
- `determine-consultant-eligibility`
- `get-consultant-commission-earned`
- `get-consultant-pending-payouts`
- `get-consultant-units-sold`
- `get-referral-link`
- `get-unit-status`

Policy C: admin or consultant

- `validate-serialized-units`

### Admin (28)

Privileged endpoints. Most use `ADMIN_ROLES`; reporting-only endpoints use `REPORTING_ROLES`.

Uses `REPORTING_ROLES`:

- `calculate-royalty`
- `identify-license-holder`

Uses `ADMIN_ROLES`:

- `apply-fraud-auto-lock`
- `approve-payouts`
- `assign-commission-rate`
- `assign-product-license`
- `associate-order-consultant`
- `bulk-upload-units`
- `calculate-commission`
- `create-consultant`
- `create-fraud-flag`
- `create-inventory-ledger-entries`
- `create-product`
- `edit-product`
- `escalate-fraud-flag`
- `export-royalty-csv`
- `insert-commission-entries`
- `insert-royalty-entry`
- `lock-units`
- `manual-lock-unit`
- `release-unit-lock`
- `resolve-fraud-flag`
- `set-commission-tier-rates`
- `test`
- `view-consultant-performance`
- `view-fraud-events`
- `view-unit-history`
- `view-unit-status`

### Internal (2)

System-invoked or service-key constrained.

- `process-order-ledger`
- `stripe-webhook`

### Scheduled (8)

Batch/scheduled finance/ledger operations.

- `aggregate-ledger-by-month`
- `calculate-gross`
- `calculate-royalties-owed`
- `compile-monthly-invoice`
- `detect-duplicate-serials`
- `generate-army-report`
- `generate-clc-report`
- `generate-invoice-record`

## Notes

- Endpoint inventory source: `docs/edge-function-surface.md`.
- This class model intentionally separates `public` from `authenticated` (Phase 7 rationalization target).
