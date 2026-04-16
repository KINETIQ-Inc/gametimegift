-- =============================================================================
-- Migration: 20260307000045_license_holders_product_dependency
--
-- Purpose:
--   1) Harden license_holders constraints at the DB layer.
--   2) Enforce "products depend on licenses" for royalty-bearing products.
--
-- Notes:
--   - Existing schema already defines public.license_holders.
--   - This migration adds missing invariants without changing app code.
-- =============================================================================

-- ─── 1) license_holders invariants ───────────────────────────────────────────

-- Only royalty-bearing authorities belong in license_holders.
-- 'NONE' is valid for products, but not for a licensing authority record.
alter table public.license_holders
  add constraint license_holders_license_body_royalty_only
  check (license_body in ('CLC', 'ARMY'));

-- Enforce at most one active record per license_body.
-- Previously documented as an app-level rule; now guaranteed by DB.
create unique index license_holders_one_active_per_body_uidx
  on public.license_holders (license_body)
  where is_active = true;

-- ─── 2) products depend on license_holders ───────────────────────────────────

-- Royalty-bearing products (CLC/ARMY) must have an active license holder row.
-- Non-licensed products (license_body = 'NONE') bypass this check.
create or replace function public.assert_active_license_holder_for_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.license_body = 'NONE' then
    return new;
  end if;

  if not exists (
    select 1
    from public.license_holders lh
    where lh.license_body = new.license_body
      and lh.is_active = true
      and lh.rate_effective_date <= current_date
      and (lh.rate_expiry_date is null or current_date < lh.rate_expiry_date)
  ) then
    raise exception
      '[GTG] Cannot create/update product with license_body=%: no active license_holders record exists for today.',
      new.license_body;
  end if;

  return new;
end;
$$;

drop trigger if exists products_require_active_license_holder on public.products;

create trigger products_require_active_license_holder
  before insert or update of license_body
  on public.products
  for each row
  execute function public.assert_active_license_holder_for_product();

