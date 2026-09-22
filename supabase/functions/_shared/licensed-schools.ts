/**
 * Licensed schools — the allowlist of CLC-licensed programs GTG may sell under.
 *
 * SYNC REQUIREMENT: this list (and the school codes below) must match
 * `packages/domain/src/licensed-schools.ts` exactly. Deno edge functions can't
 * import the pnpm workspace package, so the list is duplicated here. Update
 * both when a license is added or dropped.
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

/** Short codes used to generate apparel style_keys (see _shared/apparel.ts). */
export const LICENSED_SCHOOL_CODES: Record<string, string> = {
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

export function isLicensedSchool(name: string): boolean {
  const target = normalize(name)
  return LICENSED_SCHOOLS.some((school) => normalize(school) === target)
}

/** Resolve a licensed school's short code. Returns null if not licensed. */
export function getLicensedSchoolCode(name: string): string | null {
  const target = normalize(name)
  const match = LICENSED_SCHOOLS.find((school) => normalize(school) === target)
  return match ? LICENSED_SCHOOL_CODES[match] : null
}

/**
 * Single source of truth for the "a CLC product must have a licensed school"
 * rule. Every code path that can leave a product with license_body = 'CLC'
 * — create-product, edit-product, and assign-product-license — must call
 * this with the EFFECTIVE post-write license_body and school (the incoming
 * value if the request changes it, the existing row's value otherwise), not
 * just the values present in the current request body. Returns an error
 * message to surface as a 400, or null when valid.
 */
export function validateClcSchool(
  effectiveLicenseBody: string,
  effectiveSchool: string | null | undefined,
): string | null {
  if (effectiveLicenseBody !== 'CLC') return null

  if (effectiveSchool === null || effectiveSchool === undefined) {
    return "school is required when license_body is 'CLC'."
  }
  if (!isLicensedSchool(effectiveSchool)) {
    return (
      `school '${effectiveSchool}' is not on the licensed-schools allowlist for CLC products. ` +
      'Add the license before assigning a product to this school.'
    )
  }
  return null
}
