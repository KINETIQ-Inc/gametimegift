/**
 * Licensed schools — the allowlist of CLC-licensed programs GTG may sell under.
 *
 * SYNC REQUIREMENT: this list must match `supabase/functions/_shared/licensed-schools.ts`
 * exactly. Deno edge functions cannot import this pnpm workspace package, so the
 * list is duplicated there. Update both when a license is added or dropped.
 *
 * This governs `products.school` when `license_body = 'CLC'`. It is a business
 * fact (which licenses the company currently holds), not a UI preference — the
 * storefront nav, admin product form, and edge function validation all read from
 * this single list so they can never drift apart.
 */

export const LICENSED_SCHOOLS = [
  'North Carolina A&T State University',
  'United States Military Academy',
  'United States Naval Academy',
  'University of Florida',
  'Clemson University',
  'The University of Alabama',
  'Louisiana State University',
  'University of Maryland',
  'Michigan State University',
  'University of South Carolina',
] as const

export type LicensedSchool = (typeof LICENSED_SCHOOLS)[number]

/**
 * Short codes used to generate apparel `style_key`s (e.g. `APP-CLEMSON-HOODIE`).
 * Keys are the canonical names in `LICENSED_SCHOOLS`.
 */
export const LICENSED_SCHOOL_CODES: Record<LicensedSchool, string> = {
  'North Carolina A&T State University': 'NCAT',
  'United States Military Academy': 'ARMY',
  'United States Naval Academy': 'NAVY',
  'University of Florida': 'UF',
  'Clemson University': 'CLEMSON',
  'The University of Alabama': 'ALABAMA',
  'Louisiana State University': 'LSU',
  'University of Maryland': 'UMD',
  'Michigan State University': 'MSU',
  'University of South Carolina': 'USC',
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * True if `name` matches a licensed school, case/whitespace-insensitive.
 * Does not validate license_body — callers should only apply this check to
 * CLC-licensed products (unlicensed/ARMY-generic products don't go through
 * this allowlist).
 */
export function isLicensedSchool(name: string): boolean {
  const target = normalize(name)
  return LICENSED_SCHOOLS.some((school) => normalize(school) === target)
}

/**
 * Resolve a licensed school's short code for style_key generation.
 * Returns null if the name isn't on the licensed list.
 */
export function getLicensedSchoolCode(name: string): string | null {
  const target = normalize(name)
  const match = LICENSED_SCHOOLS.find((school) => normalize(school) === target)
  return match ? LICENSED_SCHOOL_CODES[match] : null
}
