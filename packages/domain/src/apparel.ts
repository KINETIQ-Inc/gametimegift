/**
 * Apparel presentation rules: canonical size ordering, garment types, and
 * style_key generation.
 *
 * Kept separate from product-categories.ts because that module is validation
 * (is this data legal?) while this one is ordering/display and the
 * style_key generator (ADR-0001) — different reasons to change.
 */

import type { ApparelSize } from '@gtg/types'
import { getLicensedSchoolCode } from './licensed-schools'

/** Canonical display order for apparel sizes, smallest to largest. */
export const APPAREL_SIZE_ORDER: readonly ApparelSize[] = ['S', 'M', 'L', 'XL', '2XL', '3XL']

export function compareApparelSizes(a: ApparelSize, b: ApparelSize): number {
  return APPAREL_SIZE_ORDER.indexOf(a) - APPAREL_SIZE_ORDER.indexOf(b)
}

/** Garment types offered in the apparel line. Extend as the catalog grows. */
export const GARMENT_TYPES = ['HOODIE', 'TEE', 'LS_TEE', 'CREWNECK'] as const

export type GarmentType = (typeof GARMENT_TYPES)[number]

export function isGarmentType(value: string): value is GarmentType {
  return (GARMENT_TYPES as readonly string[]).includes(value)
}

/**
 * Deterministically generates an apparel style_key from a licensed school
 * name and garment type, e.g. ('Clemson University', 'HOODIE') →
 * 'APP-CLEMSON-HOODIE'. The full SKU appends size, e.g.
 * 'APP-CLEMSON-HOODIE-M'.
 *
 * See docs/adr/0001-style-key-immutability.md — this is the only sanctioned
 * way to produce a style_key. Admins never type one by hand.
 *
 * Returns null if `school` isn't a licensed school (see licensed-schools.ts).
 */
export function generateStyleKey(school: string, garmentType: GarmentType): string | null {
  const schoolCode = getLicensedSchoolCode(school)
  if (schoolCode === null) return null
  return `APP-${schoolCode}-${garmentType}`
}
