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
