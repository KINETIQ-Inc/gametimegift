-- =============================================================================
-- Migration: 20260305000016_unit_level_uniqueness
--
-- Enforces three unit-level uniqueness invariants:
--
--   1. Hologram ID uniqueness (new)
--      A physical hologram label may be applied to at most one serialized unit.
--      Duplicate hologram IDs are a primary fraud signal and must be structurally
--      impossible, not merely detected after the fact.
--
--   2. order_lines.unit_id partial uniqueness (replaces unconditional constraint)
--      A unit may appear on at most one *active* order line at a time.
--      Returned and cancelled lines are excluded so that a unit which has been
--      returned to inventory (status → 'available') can be sold again and receive
--      a new order line.
--
--   3. commission_entries.unit_id partial uniqueness (replaces unconditional constraint)
--      A unit may have at most one *active* commission entry at a time.
--      Reversed and voided entries are excluded for the same reason — a reversed
--      commission on a returned unit must not block the commission entry for its
--      next sale.
--
-- Why partial indexes rather than partial constraints?
--   PostgreSQL supports partial unique indexes but not partial UNIQUE constraints
--   in the CREATE TABLE or ALTER TABLE ADD CONSTRAINT syntax. A partial unique
--   index is semantically equivalent and enforced by the query planner and
--   INSERT/UPDATE executor identically to a constraint-based unique index.
-- =============================================================================


-- ─── 1. Hologram ID uniqueness ────────────────────────────────────────────────
-- Extracts hologramId from the JSONB column using a functional expression.
-- The hologram field stores a HologramRecord snapshot:
--   { hologramId, batchId, appliedAt, appliedBy, verifyBaseUrl }
--
-- Partial: only rows where hologram is non-null are indexed.
-- Units that have not yet received a hologram (hologram IS NULL) are excluded.
--
-- Compliance note:
--   'duplicate_hologram' is a named fraud_signal_source. Enforcing this at the
--   DB level makes the fraud signal impossible to produce by accident — an
--   attempt to apply the same hologram to a second unit fails at INSERT/UPDATE
--   with a unique violation before any fraud flag is needed.

create unique index serialized_units_hologram_id_unique_idx
  on public.serialized_units ((hologram->>'hologramId'))
  where hologram is not null;

comment on index serialized_units_hologram_id_unique_idx is
  'Enforces 1:1 between physical hologram labels and serialized units. '
  'A hologramId from HologramRecord may appear on at most one unit row. '
  'Prevents duplicate_hologram fraud signals at the structural level.';


-- ─── 2. order_lines.unit_id — replace with partial unique index ───────────────
-- The unconditional unique constraint created in migration 7 blocks resale of
-- returned units. The partial index below replaces it:
--   - Still prevents double-selling: only one active line per unit.
--   - Allows resale: a returned or cancelled line does not block a new line.
--
-- Active statuses for this constraint: 'reserved', 'shipped', 'delivered'.
-- Inactive statuses excluded: 'returned', 'cancelled'.
-- 'delivered' is active because a delivered unit has not been returned yet.

-- Drop the unconditional unique constraint (also drops its implicit index).
alter table public.order_lines
  drop constraint order_lines_unit_unique;

-- Replace with a partial unique index covering only active line statuses.
create unique index order_lines_unit_id_active_unique_idx
  on public.order_lines (unit_id)
  where status not in ('returned', 'cancelled');

comment on index order_lines_unit_id_active_unique_idx is
  'A serialized unit may appear on at most one active order line at a time. '
  'Returned and cancelled lines are excluded so that a unit returned to '
  'inventory (status → available) may be placed on a new order line.';


-- ─── 3. commission_entries.unit_id — replace with partial unique index ─────────
-- The unconditional unique constraint created in migration 9 blocks a new
-- commission entry for a unit whose prior commission was reversed (returned sale).
-- The partial index below replaces it:
--   - Still prevents duplicate active commission obligations per unit.
--   - Allows a new commission entry when the prior one is reversed or voided.
--
-- Active statuses for this constraint: 'earned', 'held', 'approved', 'paid'.
-- Inactive statuses excluded: 'reversed', 'voided'.

-- Drop the unconditional unique constraint.
alter table public.commission_entries
  drop constraint commission_entries_unit_unique;

-- Replace with a partial unique index covering only active commission statuses.
create unique index commission_entries_unit_id_active_unique_idx
  on public.commission_entries (unit_id)
  where status not in ('reversed', 'voided');

comment on index commission_entries_unit_id_active_unique_idx is
  'A serialized unit may have at most one active commission obligation at a time. '
  'Reversed and voided entries are excluded so that a returned-and-resold unit '
  'can receive a new commission entry for the second sale.';
