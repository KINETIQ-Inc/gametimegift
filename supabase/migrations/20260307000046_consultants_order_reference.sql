-- =============================================================================
-- Migration: 20260307000046_consultants_order_reference
--
-- Phase 4A-2: consultants
-- Objective:
--   - Harden consultant relational integrity.
--   - Ensure orders may safely reference consultant_id.
-- =============================================================================

-- ─── consultant_profiles self-reference integrity ────────────────────────────
-- referred_by should point to an existing consultant profile when present.
-- ON DELETE RESTRICT preserves referral attribution history.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'consultant_profiles_referred_by_fkey'
      and conrelid = 'public.consultant_profiles'::regclass
  ) then
    alter table public.consultant_profiles
      add constraint consultant_profiles_referred_by_fkey
        foreign key (referred_by)
        references public.consultant_profiles (id)
        on delete restrict;
  end if;
end $$;

-- Prevent self-referral rows.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'consultant_profiles_referred_by_not_self'
      and conrelid = 'public.consultant_profiles'::regclass
  ) then
    alter table public.consultant_profiles
      add constraint consultant_profiles_referred_by_not_self
        check (referred_by is null or referred_by <> id);
  end if;
end $$;

-- ─── orders consultant reference quality ─────────────────────────────────────
-- consultant_name is a snapshot field; enforce non-blank when present.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_consultant_name_nonblank'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_consultant_name_nonblank
        check (consultant_name is null or btrim(consultant_name) <> '');
  end if;
end $$;

-- Support common consultant order-history queries.
create index if not exists orders_consultant_created_at_idx
  on public.orders (consultant_id, created_at desc)
  where consultant_id is not null;

