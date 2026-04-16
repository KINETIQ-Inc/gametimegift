-- =============================================================================
-- Migration: 20260305000015_add_deferred_foreign_keys
--
-- Adds FK constraints that were left as bare uuid columns in earlier migrations
-- because the referenced table did not yet exist at the time of creation.
-- All referenced tables now exist; it is safe to enforce referential integrity.
--
-- ─── FKs added in this migration ─────────────────────────────────────────────
--
--   inventory_ledger_entries.order_id     → orders.id
--   inventory_ledger_entries.consultant_id → consultant_profiles.id
--   fraud_flags.related_order_id          → orders.id
--   fraud_flags.related_consultant_id     → consultant_profiles.id
--
-- ─── Intentionally omitted FKs (documented here for completeness) ────────────
--
--   commission_entries.payout_batch_id
--     → payout_batches.id (table does not exist yet; FK added in that migration)
--
--   consultant_profiles.referred_by
--     → consultant_profiles.id (self-referential)
--     Omitted by design. A self-referential FK with ON DELETE SET NULL would
--     silently clear the referral chain if a referrer is terminated. Referral
--     attribution is immutable for commission accounting purposes. The uuid is
--     validated at the application layer on write.
--
--   lock_records.target_id
--     → (multi-scope: serialized_units | consultant_profiles | orders)
--     Stored as text, not uuid, to accommodate multiple target types in a single
--     column. PostgreSQL does not support polymorphic FK constraints. The
--     application layer enforces referential validity using the scope column.
--
--   royalty_entries.ledger_entry_ids  uuid[]
--     → inventory_ledger_entries.id (array)
--     PostgreSQL does not support FK constraints on array columns. Referential
--     integrity is enforced by the royalty calculation service, which builds
--     the array exclusively from verified ledger entry IDs before inserting.
--
-- =============================================================================


-- ─── inventory_ledger_entries.order_id → orders ───────────────────────────────
-- Context field populated for: reserved, reservation_released, sold, returned.
-- Null for actions that have no order context (received, hologram_applied, etc.).
-- ON DELETE RESTRICT — a ledger entry must never be orphaned if an order is
-- somehow removed. (Orders are never deleted, so this is a safety guard only.)

alter table public.inventory_ledger_entries
  add constraint inventory_ledger_entries_order_id_fkey
    foreign key (order_id) references public.orders (id);

-- ─── inventory_ledger_entries.consultant_id → consultant_profiles ─────────────
-- Context field populated for: sold, returned (consultant-assisted sales only).
-- Null for storefront-direct and admin sales.

alter table public.inventory_ledger_entries
  add constraint inventory_ledger_entries_consultant_id_fkey
    foreign key (consultant_id) references public.consultant_profiles (id);

-- ─── fraud_flags.related_order_id → orders ───────────────────────────────────
-- Populated for signals that originate from a specific order:
--   duplicate_serial     — the order on which the duplicate appeared
--   payment_chargeback   — the order associated with the disputed charge
-- Null for all other signal sources.

alter table public.fraud_flags
  add constraint fraud_flags_related_order_id_fkey
    foreign key (related_order_id) references public.orders (id);

-- ─── fraud_flags.related_consultant_id → consultant_profiles ─────────────────
-- Populated for signals that originate from or implicate a consultant:
--   consultant_report    — the consultant who filed the report
--   velocity_anomaly     — the consultant whose account triggered the anomaly
-- Null for all other signal sources.

alter table public.fraud_flags
  add constraint fraud_flags_related_consultant_id_fkey
    foreign key (related_consultant_id) references public.consultant_profiles (id);
