-- =============================================================================
-- Migration: 20260305000033_set_commission_tier_rates_fn
--
-- Creates:
--   function public.set_commission_tier_rates   atomic commission tier rate update
--
-- ─── Purpose ─────────────────────────────────────────────────────────────────
--
-- Updates the active commission rate for one or more named tiers (standard,
-- senior, elite) in a single atomic transaction. The 'custom' tier is excluded
-- — its rate lives on consultant_profiles.custom_commission_rate.
--
-- ─── Rate change workflow ─────────────────────────────────────────────────────
--
-- Rates are append-only. For each tier being updated:
--
--   1. The current active row (is_active = true) is deactivated in place.
--   2. A new row with the new rate is inserted as is_active = true.
--
-- The partial unique index commission_tier_config_active_tier_unique prevents
-- two active rows for the same tier. Because both steps run inside a single
-- transaction (PL/pgSQL block), a failed INSERT rolls back the deactivation —
-- the tier is never left without an active rate.
--
-- ─── Atomicity guarantee ─────────────────────────────────────────────────────
--
-- All tier updates in the p_updates array are processed in one transaction.
-- If any tier fails validation or write, the entire call is rolled back.
-- This prevents partial-success states (e.g., standard updated, senior not).
--
-- ─── No active row ───────────────────────────────────────────────────────────
--
-- If a tier has no active row (unusual — only possible if a previous deactivation
-- left no replacement), the UPDATE step is a no-op and only the INSERT runs.
-- The tier becomes active again with the new rate.
--
-- ─── Response ────────────────────────────────────────────────────────────────
--
-- Returns JSONB with two sections:
--
--   changes[]      — one entry per tier updated:
--                    { tier, old_rate (null if no prior active row), new_rate }
--
--   active_rates[] — all currently active tier rates across all named tiers
--                    (including unchanged ones), ordered by tier name.
--                    The caller always sees the full picture after the update.
-- =============================================================================

create or replace function public.set_commission_tier_rates(
  p_updates  jsonb,   -- [{ "tier": "standard", "rate": 0.11, "notes": "..." }, ...]
  p_set_by   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_update       jsonb;
  v_tier         text;
  v_rate         numeric;
  v_notes        text;
  v_old_rate     numeric;
  v_changes      jsonb := '[]'::jsonb;
  v_active_rates jsonb;
begin

  -- ── Validate input ─────────────────────────────────────────────────────────
  if p_updates is null or jsonb_typeof(p_updates) != 'array' then
    raise exception
      '[GTG] set_commission_tier_rates: p_updates must be a non-null JSON array.';
  end if;

  if jsonb_array_length(p_updates) = 0 then
    raise exception
      '[GTG] set_commission_tier_rates: p_updates array must contain at least one tier update.';
  end if;

  -- ── Process each tier update ───────────────────────────────────────────────
  for v_update in select * from jsonb_array_elements(p_updates)
  loop
    v_tier  := v_update->>'tier';
    v_notes := v_update->>'notes';

    -- Parse rate (will be null if key is absent or value is JSON null)
    begin
      v_rate := (v_update->>'rate')::numeric;
    exception when others then
      raise exception
        '[GTG] set_commission_tier_rates: rate for tier ''%'' must be a numeric value.',
        coalesce(v_tier, '(missing)');
    end;

    -- Validate tier
    if v_tier is null or v_tier not in ('standard', 'senior', 'elite') then
      raise exception
        '[GTG] set_commission_tier_rates: invalid tier ''%''. '
        'Must be standard, senior, or elite. '
        'The custom tier rate lives on consultant_profiles.custom_commission_rate.',
        coalesce(v_tier, '(null)');
    end if;

    -- Validate rate
    if v_rate is null then
      raise exception
        '[GTG] set_commission_tier_rates: rate is required for tier ''%''.',
        v_tier;
    end if;

    if v_rate <= 0 or v_rate > 1 then
      raise exception
        '[GTG] set_commission_tier_rates: rate for tier ''%'' must be > 0 and <= 1, got ''%''.',
        v_tier, v_rate;
    end if;

    -- Validate notes
    if v_notes is null or trim(v_notes) = '' then
      raise exception
        '[GTG] set_commission_tier_rates: notes are required for tier ''%''. '
        'Document the reason for this rate change.',
        v_tier;
    end if;

    -- ── Capture current active rate (null if no active row exists) ───────────
    select rate
    into v_old_rate
    from public.commission_tier_config
    where tier      = v_tier::public.commission_tier
      and is_active = true;

    -- ── Deactivate current active row ────────────────────────────────────────
    -- No-op if no active row exists (v_old_rate is null).
    update public.commission_tier_config
    set is_active = false
    where tier      = v_tier::public.commission_tier
      and is_active = true;

    -- ── Insert new active row ─────────────────────────────────────────────────
    insert into public.commission_tier_config (
      tier,
      rate,
      notes,
      created_by
    )
    values (
      v_tier::public.commission_tier,
      v_rate,
      trim(v_notes),
      p_set_by
    );

    -- ── Accumulate change record ──────────────────────────────────────────────
    v_changes := v_changes || jsonb_build_array(
      jsonb_build_object(
        'tier',     v_tier,
        'old_rate', v_old_rate,
        'new_rate', v_rate
      )
    );

  end loop;

  -- ── Collect all active rates for full response picture ────────────────────
  -- Includes tiers that were not part of this update call — the caller
  -- always receives the complete current state after the write.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',         id,
        'tier',       tier,
        'rate',       rate,
        'notes',      notes,
        'created_at', created_at,
        'created_by', created_by
      )
      order by tier
    ),
    '[]'::jsonb
  )
  into v_active_rates
  from public.commission_tier_config
  where is_active = true
    and tier      != 'custom';

  return jsonb_build_object(
    'changes',      v_changes,
    'active_rates', v_active_rates
  );

end;
$$;

grant execute on function public.set_commission_tier_rates(jsonb, uuid)
  to service_role;

comment on function public.set_commission_tier_rates(jsonb, uuid) is
  'Atomically updates commission rates for one or more named tiers '
  '(standard, senior, elite). For each tier: deactivates the current active row '
  'and inserts a new active row with the new rate. Both steps run in one '
  'transaction — a failed insert rolls back the deactivation, leaving the tier '
  'with its prior rate. Returns { changes[], active_rates[] } where active_rates '
  'includes all tiers (not just those changed). Called by set-commission-tier-rates (4A-4).';
