-- =============================================================================
-- Migration: 20260305000017_serial_format_enforcement
--
-- Enforces format constraints on serial identifiers that were previously
-- missing or too loose to provide meaningful validation.
--
-- Changes:
--   1. serialized_units.serial_number       — add format check (new)
--   2. consultant_profiles.email            — upgrade from LIKE to regex
--   3. orders.customer_email               — upgrade from LIKE to regex
--   4. license_holders.contact_email       — upgrade from LIKE to regex
--   5. payment_events.customer_email       — upgrade from LIKE to regex
--
-- ─── Serial number format ─────────────────────────────────────────────────────
--   Pattern: ^[A-Z0-9][A-Z0-9-]{5,63}$
--
--   - Uppercase letters, digits, and hyphens only.
--   - Must start with an uppercase letter or digit (no leading hyphen).
--   - Minimum length 6 characters, maximum 64.
--   - Consistent with the SKU format established in products (migration 1)
--     and batch_number format in manufacturing_batches (migration 3).
--
--   Serial numbers originate from GTG's receiving system or from a manufacturer.
--   The format is enforced at the source table (serialized_units) only.
--   Denormalized serial_number columns in order_lines, inventory_ledger_entries,
--   commission_entries, and fraud_flags are populated exclusively by copying
--   from a validated serialized_units row, so their values are guaranteed to
--   satisfy this constraint without redundant re-checking on every insert.
--
-- ─── Email format upgrade ─────────────────────────────────────────────────────
--   Old:  email LIKE '%@%'
--   New:  email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
--
--   The LIKE check only required an @ symbol anywhere in the string — it accepts
--   '@', 'x@y', and 'not-an-email@' as valid. The regex requires:
--     - Non-empty local part (at least one non-@ non-whitespace character)
--     - Exactly one @ separator
--     - Domain part with at least one dot (requires a TLD)
--     - No whitespace anywhere
--
--   This is not full RFC 5322 validation (impractically complex in SQL) but it
--   rejects all obviously malformed values and is consistent across all tables.
-- =============================================================================


-- ─── 1. serialized_units.serial_number format ────────────────────────────────

alter table public.serialized_units
  add constraint serialized_units_serial_number_format
    check (serial_number ~ '^[A-Z0-9][A-Z0-9-]{5,63}$');

comment on constraint serialized_units_serial_number_format
  on public.serialized_units is
  'Serial numbers must be 6–64 uppercase alphanumeric characters with hyphens. '
  'Must start with a letter or digit. Consistent with SKU and batch_number format.';


-- ─── 2. consultant_profiles.email ────────────────────────────────────────────

alter table public.consultant_profiles
  drop constraint consultant_profiles_email_format;

alter table public.consultant_profiles
  add constraint consultant_profiles_email_format
    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');


-- ─── 3. orders.customer_email ────────────────────────────────────────────────

alter table public.orders
  drop constraint orders_customer_email_format;

alter table public.orders
  add constraint orders_customer_email_format
    check (customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');


-- ─── 4. license_holders.contact_email ────────────────────────────────────────

alter table public.license_holders
  drop constraint license_holders_email_format;

alter table public.license_holders
  add constraint license_holders_email_format
    check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');


-- ─── 5. payment_events.customer_email ────────────────────────────────────────

alter table public.payment_events
  drop constraint payment_events_customer_email_format;

alter table public.payment_events
  add constraint payment_events_customer_email_format
    check (customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
