-- =============================================================================
-- Migration: 20260305000035_get_available_unit_counts_fn
--
-- Creates:
--   function public.get_available_unit_counts
--
-- Purpose:
--   Returns the count of available (status = 'available') serialized units
--   for each product in a given set of product IDs. Used by the storefront
--   list-products Edge Function to add per-product stock counts to the
--   catalog response in a single round-trip.
--
--   A GROUP BY in application code would require fetching O(total_units)
--   rows. This function performs the aggregation in the DB, returning only
--   one row per product that has stock — O(distinct_products_with_stock).
--
-- Returns:
--   TABLE(product_id uuid, available_count integer)
--   Only product_ids that have at least one available unit are returned.
--   Products with zero available units are absent from the result set
--   (the caller treats a missing entry as available_count = 0).
--
-- Caller:
--   list-products Edge Function via admin.rpc('get_available_unit_counts', {...}).
--   The function is granted to service_role; the Edge Function's admin client
--   (service role key) satisfies this grant.
-- =============================================================================

create or replace function public.get_available_unit_counts(
  p_product_ids uuid[]
)
returns table (
  product_id      uuid,
  available_count integer
)
language sql
security definer
set search_path = public
as $$
  select
    product_id,
    count(*)::integer as available_count
  from public.serialized_units
  where status = 'available'
    and product_id = any(p_product_ids)
  group by product_id;
$$;

-- ─── Permissions ──────────────────────────────────────────────────────────────
grant execute on function public.get_available_unit_counts(uuid[])
  to service_role;

-- ─── Documentation ────────────────────────────────────────────────────────────
comment on function public.get_available_unit_counts(uuid[]) is
  'Returns available unit counts for a set of product IDs. '
  'Only products with at least one available unit are included in the result. '
  'Called by the list-products Edge Function to annotate the catalog with '
  'real-time stock availability in a single aggregation query.';
