-- =============================================================================
-- Migration: 20260305000039_referral_code
--
-- Adds:
--   column public.consultant_profiles.referral_code  short unique sharing code
--   function public.generate_referral_code           deterministic code generator
--   trigger consultant_profiles_set_referral_code    auto-assigns on INSERT
--
-- ─── Purpose ──────────────────────────────────────────────────────────────────
--
-- Consultants share their referral link with customers to attribute purchases.
-- A UUID in a URL is not memorable or suitable for verbal sharing. The referral
-- code produces a short, uppercase alphanumeric token that is:
--
--   - Human-readable and verbally shareable (e.g. "SMITHA3F2")
--   - Safe in URLs with no encoding needed
--   - Unique across all consultant profiles (UNIQUE constraint)
--   - Deterministically generated — same inputs always produce the same base code,
--     with a collision-retry mechanism that appends additional UUID characters.
--
-- ─── Code format ──────────────────────────────────────────────────────────────
--
--   <NAME_PREFIX><UUID_SUFFIX>
--
--   NAME_PREFIX  Up to 5 uppercase alphanumeric characters from legal_last_name.
--                Non-alphanumeric characters are stripped. Short last names use
--                all available characters.
--
--   UUID_SUFFIX  First 4 uppercase hex characters of the consultant's UUID
--                (hyphens removed). Extended to 6 characters on collision retry.
--
--   Examples:
--     Jane Smith,   id=a3f2...  →  SMITHA3F2
--     Bob O'Brien,  id=c91d...  →  OBRIENC91D
--     Xiu Li,       id=04a8...  →  LI04A8
--
-- ─── Existing rows ────────────────────────────────────────────────────────────
--
-- The column is added as nullable with no default. Existing consultant rows will
-- have referral_code = NULL until the get-referral-link Edge Function (6A-1)
-- generates and persists the code on first access.
--
-- ─── Storefront URL convention ────────────────────────────────────────────────
--
-- The referral link is constructed by the Edge Function as:
--   ${STOREFRONT_URL}/shop?ref=<referral_code>
--
-- The storefront resolves <referral_code> back to a consultant_profiles.id by
-- querying WHERE referral_code = $1, then passes the id as consultant_id in
-- the checkout session.
-- =============================================================================


-- ─── Column ───────────────────────────────────────────────────────────────────

alter table public.consultant_profiles
  add column referral_code text;

-- Unique: two consultants cannot have the same referral code.
alter table public.consultant_profiles
  add constraint consultant_profiles_referral_code_unique
    unique (referral_code);

-- Code format: uppercase alphanumeric only, 4–12 characters.
alter table public.consultant_profiles
  add constraint consultant_profiles_referral_code_format
    check (
      referral_code is null
      or (
        referral_code ~ '^[A-Z0-9]{4,12}$'
        and length(referral_code) between 4 and 12
      )
    );

comment on column public.consultant_profiles.referral_code is
  'Short uppercase alphanumeric referral token for public sharing. '
  'Format: up to 5 chars from legal_last_name + 4 hex chars of UUID. '
  'Used in storefront referral URLs: /shop?ref=<referral_code>. '
  'Null for consultants created before this migration; assigned on first access '
  'by the get-referral-link Edge Function.';

create index consultant_profiles_referral_code_idx
  on public.consultant_profiles (referral_code)
  where referral_code is not null;


-- ─── Function: generate_referral_code ────────────────────────────────────────
--
-- Generates a unique referral code for a consultant given their last name and
-- profile UUID. Tries an initial code; if that code is already taken (UNIQUE
-- conflict), retries with a longer UUID suffix (4 → 6 → 8 characters) until
-- a unique code is found.
--
-- Parameters:
--   p_last_name  text  — consultant's legal_last_name
--   p_id         uuid  — consultant_profiles.id (source of UUID entropy)
--
-- Returns: text — the generated unique code, ready to write to referral_code
--
-- Raises:
--   [GTG] generate_referral_code: could not generate a unique referral code
--   (astronomically unlikely — would require 8 hex chars of UUID collision)
--
-- Caller:
--   consultant_profiles_set_referral_code trigger (on INSERT)
--   get-referral-link Edge Function (on first access for existing consultants)
-- =============================================================================

create or replace function public.generate_referral_code(
  p_last_name text,
  p_id        uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name_part  text;
  v_uuid_hex   text;
  v_candidate  text;
  v_suffix_len integer;
begin
  -- Derive name prefix: up to 5 uppercase alphanumeric characters from last name.
  -- regexp_replace strips everything except A-Z and 0-9; LEFT truncates to 5.
  v_name_part := upper(regexp_replace(p_last_name, '[^A-Za-z0-9]', '', 'g'));
  v_name_part := left(v_name_part, 5);

  -- Full UUID hex string without hyphens (32 uppercase hex chars).
  v_uuid_hex := upper(replace(p_id::text, '-', ''));

  -- Attempt codes with increasing UUID suffix lengths: 4, 6, 8 characters.
  -- Collision probability at 4 chars is ~1/65536 per pair — negligible in practice.
  foreach v_suffix_len in array array[4, 6, 8] loop
    v_candidate := v_name_part || left(v_uuid_hex, v_suffix_len);

    -- Validate length: the format constraint requires 4–12 chars.
    -- A very short last name (e.g. "Li") with 4-char suffix gives 6 chars — valid.
    if length(v_candidate) < 4 then
      -- Pad with UUID characters to meet minimum.
      v_candidate := left(v_uuid_hex, 4 + (4 - length(v_candidate)));
    end if;

    -- Check uniqueness.
    if not exists (
      select 1
      from public.consultant_profiles
      where referral_code = v_candidate
    ) then
      return v_candidate;
    end if;
  end loop;

  raise exception
    '[GTG] generate_referral_code: could not generate a unique referral code '
    'for consultant id=%. All candidates (4, 6, 8 UUID suffix lengths) are taken. '
    'This is an extremely unlikely collision — investigate manually.',
    p_id;
end;
$$;

grant execute on function public.generate_referral_code(text, uuid)
  to service_role;

comment on function public.generate_referral_code(text, uuid) is
  'Generates a unique referral code: up to 5 chars from legal_last_name + '
  '4–8 uppercase hex chars from the consultant UUID. Retries with a longer '
  'UUID suffix on collision. Called by the INSERT trigger and by the '
  'get-referral-link Edge Function for consultants created before this migration.';


-- ─── Trigger: auto-assign referral_code on INSERT ────────────────────────────

create or replace function public.set_consultant_referral_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only generate if not explicitly provided at INSERT time.
  if new.referral_code is null then
    new.referral_code := public.generate_referral_code(new.legal_last_name, new.id);
  end if;
  return new;
end;
$$;

create trigger consultant_profiles_set_referral_code
  before insert on public.consultant_profiles
  for each row
  execute function public.set_consultant_referral_code();

comment on function public.set_consultant_referral_code() is
  'Trigger function: auto-assigns a unique referral_code to new consultant_profiles '
  'rows using generate_referral_code(). Skipped if referral_code is explicitly '
  'provided at INSERT time (e.g. during data migration or testing).';
