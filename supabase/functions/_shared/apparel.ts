/**
 * Apparel category/size/style_key validation and generation for edge
 * functions.
 *
 * SYNC REQUIREMENT: must match `packages/domain/src/product-categories.ts` and
 * `packages/domain/src/apparel.ts` exactly. Deno edge functions can't import
 * the pnpm workspace package, so this logic is duplicated here. See
 * docs/adr/0001-style-key-immutability.md and
 * docs/adr/0002-apparel-variant-model-and-phasing.md.
 */

import { getLicensedSchoolCode } from './licensed-schools.ts'

export const VALID_PRODUCT_CATEGORIES = new Set(['COLLECTIBLE', 'APPAREL'])
export const VALID_APPAREL_SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL'])
export const GARMENT_TYPES = new Set(['HOODIE', 'TEE', 'LS_TEE', 'CREWNECK'])

/**
 * Deterministically generates an apparel style_key from a licensed school name
 * and garment type, e.g. ('Clemson University', 'HOODIE') ->
 * 'APP-CLEMSON-HOODIE'. Returns null if `school` isn't a licensed school.
 *
 * This is the only sanctioned way to produce a style_key — never accept one
 * directly from a request body.
 */
export function generateStyleKey(school: string, garmentType: string): string | null {
  const schoolCode = getLicensedSchoolCode(school)
  if (schoolCode === null) return null
  return `APP-${schoolCode}-${garmentType}`
}

/**
 * Enforces the same category/apparel-field null-ness rule as the
 * `products_category_fields_consistent` DB check constraint.
 * Returns a validation-error message, or null when consistent.
 */
export function validateApparelFields(
  category: string,
  size: string | null | undefined,
  color: string | null | undefined,
  garmentType: string | null | undefined,
): string | null {
  if (category === 'COLLECTIBLE') {
    if (size != null || color != null || garmentType != null) {
      return 'size, color, and garment_type must not be set when category is COLLECTIBLE.'
    }
    return null
  }

  // APPAREL
  if (size == null || !VALID_APPAREL_SIZES.has(size)) {
    return `size is required when category is APPAREL and must be one of: ${[...VALID_APPAREL_SIZES].join(', ')}.`
  }
  if (garmentType == null || !GARMENT_TYPES.has(garmentType)) {
    return `garment_type is required when category is APPAREL and must be one of: ${[...GARMENT_TYPES].join(', ')}.`
  }
  return null
}
