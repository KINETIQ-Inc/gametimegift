-- =============================================================================
-- Migration: 20260921000100_add_apparel_category_to_products
--
-- Creates:
--   type  public.product_category            enum: COLLECTIBLE | APPAREL
--   type  public.product_lifecycle_status     enum: DRAFT..ARCHIVED (see ADR-0007)
--   func  public.prevent_style_key_update()  immutability guard (see ADR-0001)
--
-- Alters:
--   table public.products                    adds category, lifecycle_status,
--                                             size, color, style_key
--
-- See docs/adr/0001-style-key-immutability.md and
-- docs/adr/0002-apparel-variant-model-and-phasing.md for the design rationale:
-- apparel size/color variants are modeled as sibling `products` rows sharing a
-- `style_key`, not a separate variants table, so every existing constraint,
-- trigger, and RLS policy on `products` keeps working unchanged.
-- =============================================================================

-- ─── Enum: product_category ───────────────────────────────────────────────────
-- Distinguishes the existing serialized-collectible catalog from the new
-- apparel line. Apparel rows require size/style_key; collectible rows must not
-- set them (see check constraint below).
--
-- SYNC REQUIREMENT: values must match @gtg/types ProductCategory exactly.

create type public.product_category as enum (
  'COLLECTIBLE',
  'APPAREL'
);

-- ─── Enum: product_lifecycle_status ───────────────────────────────────────────
-- See docs/adr/0007-product-lifecycle.md. Column only in this migration — no
-- transition-enforcement logic or admin workflow yet. `is_active` remains the
-- sole operative "can this be ordered" flag until that follow-up work lands.
--
-- SYNC REQUIREMENT: values must match @gtg/types ProductLifecycleStatus exactly.

create type public.product_lifecycle_status as enum (
  'DRAFT',
  'READY_FOR_REVIEW',
  'ACTIVE',
  'DISCONTINUED',
  'ARCHIVED'
);

-- ─── products: new columns ─────────────────────────────────────────────────────

alter table public.products
  add column category         public.product_category           not null default 'COLLECTIBLE',
  add column lifecycle_status public.product_lifecycle_status    not null default 'ACTIVE',
  -- Apparel size. Null for collectibles.
  add column size             text,
  -- Apparel color. Null for collectibles. Free text — no fixed palette today.
  add column color            text,
  -- Groups sibling apparel SKUs for one design (e.g. 'APP-CLEMSON-HOODIE').
  -- System-generated at creation time (see ADR-0001) — never admin free text,
  -- never editable after creation (enforced by trigger below). Null for
  -- collectibles.
  add column style_key        text;

-- ─── Constraints ────────────────────────────────────────────────────────────────

-- Size is constrained to a fixed set when present.
alter table public.products
  add constraint products_size_valid
  check (size is null or size in ('S', 'M', 'L', 'XL', 'XXL'));

alter table public.products
  add constraint products_color_nonempty
  check (color is null or btrim(color) <> '');

alter table public.products
  add constraint products_style_key_format
  check (style_key is null or style_key ~ '^[A-Z0-9][A-Z0-9-]{2,49}$');

-- Category/apparel-field consistency: collectibles carry none of the apparel
-- fields; apparel rows must carry size and style_key (color remains optional —
-- not every garment is offered in a distinguishing color).
alter table public.products
  add constraint products_category_fields_consistent
  check (
    (category = 'COLLECTIBLE' and size is null and color is null and style_key is null)
    or
    (category = 'APPAREL' and size is not null and style_key is not null)
  );

-- ─── style_key Immutability Trigger (ADR-0001) ────────────────────────────────
-- Mirrors prevent_sku_update() exactly (see
-- 20260305000001_create_products.sql:130-151). style_key groups sibling SKUs
-- for one apparel design; changing it after creation could split an existing
-- size/color family apart or merge it with an unrelated one, orphaning
-- inventory, ledger entries, and order history denormalized against it.

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
      'style_key groups sibling apparel SKUs and is denormalized the same way sku is. '
      'Create a new style_key (a new design) instead.',
      old.style_key, new.style_key;
  end if;
  return new;
end;
$$;

create trigger products_immutable_style_key
  before update on public.products
  for each row
  execute function public.prevent_style_key_update();

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Fetch sibling size/color variants for one apparel design.
create index products_style_key_idx
  on public.products (style_key)
  where is_active = true and style_key is not null;

-- Filter the catalog by category (collectibles vs. apparel).
create index products_category_active_idx
  on public.products (category)
  where is_active = true;

-- ─── Column Documentation ─────────────────────────────────────────────────────

comment on column public.products.category is
  'COLLECTIBLE or APPAREL. Determines whether size/color/style_key apply. '
  'See docs/adr/0002-apparel-variant-model-and-phasing.md.';

comment on column public.products.lifecycle_status is
  'Product lifecycle stage (DRAFT..ARCHIVED). Column reserved ahead of the '
  'transition workflow — is_active remains the operative order-eligibility '
  'flag today. See docs/adr/0007-product-lifecycle.md.';

comment on column public.products.size is
  'Apparel size (S/M/L/XL/XXL). Null for collectibles. Required for APPAREL.';

comment on column public.products.color is
  'Apparel color, free text. Null for collectibles. Optional for APPAREL.';

comment on column public.products.style_key is
  'Groups sibling apparel SKUs for one design (e.g. APP-CLEMSON-HOODIE). '
  'System-generated at creation from school + garment type — never admin '
  'free text. Immutable after creation (enforced by trigger). '
  'See docs/adr/0001-style-key-immutability.md.';
