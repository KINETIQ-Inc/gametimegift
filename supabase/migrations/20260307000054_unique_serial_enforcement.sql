-- =============================================================================
-- Migration: 20260307000054_unique_serial_enforcement
--
-- Phase 4C-1: Unique serial enforcement
-- Objective:
--   - Enforce serial_number uniqueness under normalization semantics.
--   - Prevent case/whitespace variants from bypassing uniqueness guarantees.
-- =============================================================================

-- Existing schema already enforces:
--   - unique(serial_number)
--   - serial format: ^[A-Z0-9][A-Z0-9-]{5,63}$
--
-- This migration adds a normalized unique index as a defense-in-depth guard.
-- If future ingest paths relax format checks, uniqueness remains protected.

create unique index if not exists serialized_units_serial_number_normalized_unique_idx
  on public.serialized_units ((upper(btrim(serial_number))));

comment on index serialized_units_serial_number_normalized_unique_idx is
  'Defense-in-depth unique enforcement for serial_number using normalized value '
  'upper(trim(serial_number)). Prevents case/whitespace variants from creating '
  'duplicate physical-unit identities.';

