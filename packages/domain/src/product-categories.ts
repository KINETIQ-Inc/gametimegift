/**
 * Product category / apparel field validation.
 *
 * Mirrors the DB check constraints added in
 * supabase/migrations/20260921000100_add_apparel_category_to_products.sql, so
 * create-product/edit-product can give a clean 400 before ever hitting
 * Postgres. See docs/adr/0002-apparel-variant-model-and-phasing.md.
 */

import type { ProductCategory, ApparelSize } from '@gtg/types'

const VALID_PRODUCT_CATEGORIES: readonly ProductCategory[] = ['COLLECTIBLE', 'APPAREL']
const VALID_APPAREL_SIZES: readonly ApparelSize[] = ['S', 'M', 'L', 'XL', 'XXL']

export function isProductCategory(value: string): value is ProductCategory {
  return VALID_PRODUCT_CATEGORIES.includes(value as ProductCategory)
}

export function assertProductCategory(value: string, context = 'category'): asserts value is ProductCategory {
  if (!isProductCategory(value)) {
    throw new Error(`[GTG] ${context} must be one of: ${VALID_PRODUCT_CATEGORIES.join(', ')}.`)
  }
}

export function isApparelSize(value: string): value is ApparelSize {
  return VALID_APPAREL_SIZES.includes(value as ApparelSize)
}

export function assertApparelSize(value: string, context = 'size'): asserts value is ApparelSize {
  if (!isApparelSize(value)) {
    throw new Error(`[GTG] ${context} must be one of: ${VALID_APPAREL_SIZES.join(', ')}.`)
  }
}

/**
 * Enforces the same category/apparel-field null-ness rule as the
 * `products_category_fields_consistent` DB check constraint:
 *   - COLLECTIBLE: size, color, and styleKey must all be absent.
 *   - APPAREL: size and styleKey are required; color is optional.
 *
 * Returns a validation-error message, or null when the fields are consistent.
 */
export function validateApparelFields(
  category: ProductCategory,
  size: string | null | undefined,
  color: string | null | undefined,
  styleKey: string | null | undefined,
): string | null {
  if (category === 'COLLECTIBLE') {
    if (size != null || color != null || styleKey != null) {
      return 'size, color, and style_key must not be set when category is COLLECTIBLE.'
    }
    return null
  }

  // APPAREL
  if (size == null) {
    return 'size is required when category is APPAREL.'
  }
  if (!isApparelSize(size)) {
    return `size must be one of: ${VALID_APPAREL_SIZES.join(', ')}.`
  }
  if (styleKey == null) {
    return 'style_key is required when category is APPAREL.'
  }
  return null
}
