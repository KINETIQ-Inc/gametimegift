-- =============================================================================
-- Migration: 20260417000100_seed_inventory_units
--
-- Seeds 100 available serialized_units for every active product.
--
-- Serial number format: {SKU}-S{NNN}   (e.g. FLA-FTBL-S001 … FLA-FTBL-S100)
-- Satisfies constraint: ^[A-Z0-9][A-Z0-9-]{5,63}$
--
-- Royalty rate resolution (mirrors bulk_receive_units logic):
--   1. product.royalty_rate override (if set)
--   2. active license_holder.default_royalty_rate for the product's license_body
--   3. 0.0001 nominal placeholder when license_body = 'NONE'
--
-- batch_id is left NULL — it is nullable on serialized_units.
-- ON CONFLICT DO NOTHING makes this migration safe to run more than once.
-- =============================================================================

DO $$
DECLARE
  v_product       RECORD;
  v_royalty_rate  NUMERIC(5, 4);
  v_holder_rate   NUMERIC(5, 4);
  v_i             INTEGER;
  v_serial        TEXT;
BEGIN
  FOR v_product IN
    SELECT
      id,
      sku,
      name          AS product_name,
      license_body,
      royalty_rate,
      cost_cents
    FROM public.products
    WHERE is_active = true
    ORDER BY created_at
  LOOP

    -- ── Resolve royalty_rate ────────────────────────────────────────────────
    IF v_product.royalty_rate IS NOT NULL THEN
      v_royalty_rate := v_product.royalty_rate;

    ELSIF v_product.license_body != 'NONE' THEN
      SELECT default_royalty_rate
        INTO v_holder_rate
        FROM public.license_holders
       WHERE license_body = v_product.license_body
         AND is_active    = true
       LIMIT 1;

      v_royalty_rate := COALESCE(v_holder_rate, 0.0001);

    ELSE
      -- license_body = 'NONE': nominal placeholder (satisfies > 0 constraint)
      v_royalty_rate := 0.0001;
    END IF;

    -- ── Insert 100 available units ──────────────────────────────────────────
    FOR v_i IN 1..100 LOOP
      v_serial := v_product.sku || '-S' || LPAD(v_i::TEXT, 3, '0');

      INSERT INTO public.serialized_units (
        serial_number,
        sku,
        product_id,
        product_name,
        status,
        license_body,
        royalty_rate,
        cost_cents
      ) VALUES (
        v_serial,
        v_product.sku,
        v_product.id,
        v_product.product_name,
        'available',
        v_product.license_body,
        v_royalty_rate,
        v_product.cost_cents
      )
      ON CONFLICT (serial_number) DO NOTHING;
    END LOOP;

  END LOOP;
END;
$$;
