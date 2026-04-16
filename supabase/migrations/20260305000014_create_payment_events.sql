-- =============================================================================
-- Migration: 20260305000014_create_payment_events
--
-- Creates:
--   type  public.payment_event_type     enum for financial event categories
--   table public.payment_events         append-only financial audit ledger
--   RLS   payment_events               admin + auditor read; admin insert
--
-- Relationship to other financial tables:
--   orders              — current financial state (totals, status, refunded_cents)
--   order_line_items    — itemized invoice detail (shipping, tax, discounts, fees)
--   payment_events      — immutable audit log of every money movement on an order
--
-- orders holds the authoritative running totals for payment processing.
-- payment_events is the append-only audit trail that explains HOW the totals
-- arrived at their current state. Every cent received, returned, or disputed
-- is recorded here, in sequence, forever.
--
-- Append-only contract:
--   No UPDATE or DELETE on this table. Ever.
--   No updated_at column — rows do not change after insert.
--   RLS defines no UPDATE or DELETE policies.
-- =============================================================================

-- ─── Enum: payment_event_type ─────────────────────────────────────────────────
-- All event types that produce an immutable payment ledger entry.
--
-- Amount sign convention (amount_cents column):
--   Positive  → net financial inflow to GTG
--               (charge_succeeded, chargeback_won, adjustment_debit)
--   Negative  → net financial outflow from GTG
--               (refund_issued, chargeback_received, adjustment_credit)
--   Zero      → status event with no settled financial impact
--               (charge_initiated, charge_failed, refund_failed, chargeback_lost)
--
-- Note: chargeback_lost carries amount_cents = 0 because the financial impact
-- was already recorded by chargeback_received. chargeback_lost marks the final
-- resolution and closes the dispute record.
--
-- SYNC REQUIREMENT: values must match @gtg/types PaymentEventType exactly.

create type public.payment_event_type as enum (
  'charge_initiated',    -- PaymentIntent created; payment attempt started
  'charge_succeeded',    -- Payment captured; funds received by GTG
  'charge_failed',       -- Payment declined or errored; no funds moved
  'refund_issued',       -- Refund submitted to payment processor
  'refund_failed',       -- Refund rejected by processor; original charge stands
  'chargeback_received', -- Customer's bank disputed a charge; funds held
  'chargeback_won',      -- Dispute resolved in GTG's favour; funds restored
  'chargeback_lost',     -- Dispute resolved in customer's favour; loss confirmed
  'adjustment_credit',   -- Admin-issued credit to customer (reduces amount owed)
  'adjustment_debit'     -- Admin-issued debit correction (e.g. underpayment)
);

-- ─── Table: payment_events ────────────────────────────────────────────────────
-- Immutable append-only audit log for every financial event on an order.
--
-- Denormalization contract:
--   order_number, customer_email, and payment_method are copied from the
--   order at event time. They remain accurate even if the order is later
--   amended or the customer changes contact details.
--
-- Stripe linkage:
--   stripe_event_id, stripe_payment_intent_id, and stripe_charge_id link
--   this row to the corresponding Stripe webhook event and objects.
--   All three are null for manual payment methods (ACH, gift card, admin).
--
-- Reconciliation:
--   To reconstruct the full financial history of an order:
--     SELECT * FROM payment_events WHERE order_id = ? ORDER BY occurred_at ASC
--   To verify the current refunded balance:
--     SELECT ABS(SUM(amount_cents)) FROM payment_events
--     WHERE order_id = ? AND event_type = 'refund_issued'
--   These figures must agree with orders.refunded_cents and orders.total_cents.

create table public.payment_events (
  -- Identity
  id                        uuid                        not null  default gen_random_uuid(),

  -- Order linkage
  order_id                  uuid                        not null  references public.orders (id),

  -- Denormalized order fields (captured at event time)
  order_number              text                        not null,
  customer_email            text                        not null,
  payment_method            public.payment_method       not null,

  -- Event classification
  event_type                public.payment_event_type   not null,

  -- Financial impact in cents (USD).
  -- Positive = inflow to GTG. Negative = outflow. Zero = status event.
  -- See amount sign convention on payment_event_type enum above.
  amount_cents              integer                     not null  default 0,

  -- Stripe linkage (null for non-Stripe payment methods)
  -- Unique ID of the Stripe webhook event that triggered this record.
  stripe_event_id           text,
  -- Stripe PaymentIntent ID (pi_*).
  stripe_payment_intent_id  text,
  -- Stripe Charge ID (ch_*). Null until a charge is created.
  stripe_charge_id          text,
  -- Stripe Refund ID (re_*). Populated for refund_issued, refund_failed.
  stripe_refund_id          text,
  -- Stripe Dispute ID (dp_*). Populated for chargeback_* events.
  stripe_dispute_id         text,

  -- Actor
  -- User ID who initiated the event. Service account for Stripe webhook events.
  performed_by              uuid                        not null  references auth.users (id),

  -- Human-readable description for audit display and customer communication.
  -- Examples: "Card ending 4242 charged", "Full refund — order cancelled",
  --           "Chargeback received from Visa", "Admin credit — duplicate charge".
  description               text                        not null,

  -- Failure detail (null unless event_type is charge_failed or refund_failed)
  -- Processor-returned error code (e.g. Stripe decline code).
  failure_code              text,
  -- Human-readable failure message. Shown in admin UI only — not to customers.
  failure_message           text,

  -- Extensible metadata for event-specific context.
  -- Never use as a substitute for a typed column.
  -- Examples: { "stripe_outcome": { "risk_level": "elevated" } }
  metadata                  jsonb,

  -- Timestamp (server-generated, immutable)
  -- Authoritative wall-clock UTC time of the financial event.
  -- Used as the cutoff for period revenue and reconciliation reports.
  occurred_at               timestamptz                 not null  default now(),

  -- ── Constraints ─────────────────────────────────────────────────────────────
  constraint payment_events_pkey
    primary key (id),

  -- Stripe event IDs are globally unique. Enforces idempotency on webhook replay:
  -- a duplicate Stripe event cannot produce a second ledger row.
  -- Partial: most events have a stripe_event_id; manual adjustments do not.
  constraint payment_events_stripe_event_id_unique
    unique (stripe_event_id),

  -- amount_cents must be negative for outflow event types.
  constraint payment_events_outflow_negative
    check (
      event_type not in ('refund_issued', 'chargeback_received', 'adjustment_credit')
      or amount_cents <= 0
    ),

  -- amount_cents must be non-negative for inflow event types.
  constraint payment_events_inflow_nonneg
    check (
      event_type not in ('charge_succeeded', 'chargeback_won', 'adjustment_debit')
      or amount_cents >= 0
    ),

  -- Failure fields are only meaningful for failed event types.
  constraint payment_events_failure_consistent
    check (
      event_type in ('charge_failed', 'refund_failed')
      or (failure_code is null and failure_message is null)
    ),

  constraint payment_events_customer_email_format
    check (customer_email like '%@%')
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- Order history: all payment events for an order, in chronological order.
-- Primary query for invoice display and financial reconciliation.
create index payment_events_order_id_idx
  on public.payment_events (order_id, occurred_at asc);

-- Stripe event deduplication: look up an event by its Stripe ID.
-- Unique constraint creates an index; this is here for documentation.
-- (The unique constraint index already covers this query.)

-- Event type filter: find all chargebacks or refunds across orders for a period.
create index payment_events_event_type_idx
  on public.payment_events (event_type, occurred_at desc);

-- Active disputes: chargeback_received events without a corresponding resolution.
-- Used for chargeback management dashboard.
create index payment_events_chargeback_open_idx
  on public.payment_events (stripe_dispute_id)
  where event_type = 'chargeback_received'
  and stripe_dispute_id is not null;

-- Period revenue: charge_succeeded events within a date range.
-- Primary driver for revenue and royalty base period reports.
create index payment_events_charges_period_idx
  on public.payment_events (occurred_at desc)
  where event_type = 'charge_succeeded';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.payment_events enable row level security;

-- SELECT: admins and licensor auditors may read the payment ledger.
-- Auditors use this to reconcile royalty base calculations against revenue.
create policy "payment_events_select_privileged"
  on public.payment_events
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin', 'licensor_auditor')
  );

-- INSERT: admin only. Events are written by payment processing Edge Functions
-- and Stripe webhook handlers using the service role client.
create policy "payment_events_insert_admin"
  on public.payment_events
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

-- UPDATE: no policy defined. This table is append-only.
-- DELETE: no policy defined. This table is append-only.

-- ─── Column Documentation ─────────────────────────────────────────────────────
comment on table public.payment_events is
  'Immutable append-only audit log for every financial event on an order. '
  'Complements orders (current state) and order_line_items (invoice detail) '
  'by recording the full sequence of money movements from first charge attempt '
  'through final settlement, refunds, and dispute resolution. '
  'No UPDATE or DELETE is permitted under any circumstance.';

comment on column public.payment_events.amount_cents is
  'Signed financial impact in cents (USD). '
  'Positive = net inflow to GTG (charge_succeeded, chargeback_won, adjustment_debit). '
  'Negative = net outflow from GTG (refund_issued, chargeback_received, adjustment_credit). '
  'Zero = status event with no settled financial impact '
  '(charge_initiated, charge_failed, refund_failed, chargeback_lost).';

comment on column public.payment_events.stripe_event_id is
  'Stripe webhook event ID (evt_*). Unique constraint enforces idempotency: '
  'replaying a Stripe webhook cannot produce a duplicate ledger entry. '
  'Null for manual payment methods and admin adjustments.';

comment on column public.payment_events.occurred_at is
  'Wall-clock UTC timestamp of the financial event, server-generated at insert time. '
  'Immutable — this is the authoritative timestamp for period revenue cutoffs '
  'and financial reconciliation reports.';

comment on column public.payment_events.failure_code is
  'Processor-returned error code for failed events (e.g. Stripe decline code: '
  '''insufficient_funds'', ''card_declined''). '
  'Null for all non-failure event types.';

comment on column public.payment_events.failure_message is
  'Human-readable failure description for admin investigation. '
  'Must not be shown to customers — use a generic message at the UI layer.';
