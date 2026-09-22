-- Close two product-integrity gaps left by the initial apparel migration.
--
-- 1. An apparel style_key is derived from school + garment type. The original
--    trigger protected style_key itself, but a service-role update could still
--    change school/category underneath it and corrupt that identity.
-- 2. lifecycle_status and is_active described the same publication state but
--    could disagree (including ARCHIVED + is_active=true).

-- Preserve explicit lifecycle decisions and the previously-operative inactive
-- flag before adding the invariant.
update public.products
set is_active = false
where lifecycle_status <> 'ACTIVE'
  and is_active = true;

update public.products
set lifecycle_status = 'DISCONTINUED'
where lifecycle_status = 'ACTIVE'
  and is_active = false;

alter table public.products
  add constraint products_lifecycle_matches_active
  check ((lifecycle_status = 'ACTIVE') = is_active);

create or replace function public.prevent_style_key_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.style_key is distinct from new.style_key then
    raise exception
      '[GTG] Product style_key is immutable. Cannot change style_key=''%'' to ''%''. '
      'Create a new apparel design instead.',
      old.style_key, new.style_key;
  end if;

  if old.style_key is not null and old.school is distinct from new.school then
    raise exception
      '[GTG] Product school is immutable once style_key=''%'' exists. '
      'style_key is derived from school; create a new apparel design instead.',
      old.style_key;
  end if;

  if old.style_key is not null and old.category is distinct from new.category then
    raise exception
      '[GTG] Product category is immutable once style_key=''%'' exists. '
      'Create a new apparel design instead.',
      old.style_key;
  end if;

  return new;
end;
$$;

comment on constraint products_lifecycle_matches_active on public.products is
  'ACTIVE products must have is_active=true; every non-ACTIVE lifecycle state must have is_active=false.';
