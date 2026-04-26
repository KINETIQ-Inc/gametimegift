-- =============================================================================
-- Migration: 20260418000400_customer_accounts_foundation
--
-- Creates:
--   table    public.customer_profiles
--   trigger  public.customer_profiles_set_updated_at
--   func     public.provision_customer_account_from_auth_user()
--   trigger  on_auth_user_created_provision_customer_account
--   RLS      customer_profiles
-- =============================================================================

create table if not exists public.customer_profiles (
  id                        uuid          not null default gen_random_uuid(),
  auth_user_id              uuid          not null references auth.users (id) on delete cascade,
  email                     text          not null,
  full_name                 text,
  phone                     text,
  default_shipping_address  jsonb,
  marketing_email_opt_in    boolean       not null default false,
  created_at                timestamptz   not null default now(),
  updated_at                timestamptz   not null default now(),

  constraint customer_profiles_pkey
    primary key (id),

  constraint customer_profiles_auth_user_unique
    unique (auth_user_id),

  constraint customer_profiles_email_format
    check (email ~* '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$')
);

create trigger customer_profiles_set_updated_at
before update on public.customer_profiles
for each row
execute function public.set_updated_at();

alter table public.customer_profiles enable row level security;

create policy customer_profiles_admin_read_all
  on public.customer_profiles
  for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'));

create policy customer_profiles_customer_read_own
  on public.customer_profiles
  for select
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
    and auth.uid() = auth_user_id
  );

create policy customer_profiles_customer_insert_own
  on public.customer_profiles
  for insert
  with check (
    (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
      and auth.uid() = auth_user_id
    )
    or (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

create policy customer_profiles_customer_update_own
  on public.customer_profiles
  for update
  using (
    (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
      and auth.uid() = auth_user_id
    )
    or (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  )
  with check (
    (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'customer'
      and auth.uid() = auth_user_id
    )
    or (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin')
  );

create or replace function public.provision_customer_account_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  if coalesce(metadata ->> 'account_type', '') <> 'customer' then
    return new;
  end if;

  update auth.users
     set raw_app_meta_data =
       coalesce(auth.users.raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object(
         'role', 'customer',
         'claimsIssuedAt', now()::text
       )
   where auth.users.id = new.id;

  insert into public.customer_profiles (
    auth_user_id,
    email,
    full_name,
    phone,
    marketing_email_opt_in
  )
  values (
    new.id,
    lower(new.email),
    nullif(trim(coalesce(metadata ->> 'full_name', '')), ''),
    nullif(trim(coalesce(metadata ->> 'phone', '')), ''),
    false
  )
  on conflict (auth_user_id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.customer_profiles.full_name),
        phone = coalesce(excluded.phone, public.customer_profiles.phone);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_provision_customer_account on auth.users;

create trigger on_auth_user_created_provision_customer_account
after insert on auth.users
for each row
execute function public.provision_customer_account_from_auth_user();

comment on table public.customer_profiles is
  'Authenticated storefront customer profiles. One row per auth.users account for customer accounts.';
