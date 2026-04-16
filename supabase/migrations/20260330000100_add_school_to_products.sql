-- =============================================================================
-- Migration: 20260330000100_add_school_to_products
--
-- Adds:
--   column public.products.school
--   index  products_school_active_idx
-- =============================================================================

alter table public.products
  add column school text;

alter table public.products
  add constraint products_school_nonempty
  check (school is null or btrim(school) <> '');

create index products_school_active_idx
  on public.products (school)
  where is_active = true and school is not null;

comment on column public.products.school is
  'Optional school or team name associated with the product for storefront browsing. '
  'Examples: University of Florida, Clemson University. Used for school-specific catalog filters.';
