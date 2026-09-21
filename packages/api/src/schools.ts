/**
 * Licensed schools — public re-export of the `@gtg/domain` allowlist.
 *
 * App code must go through `@gtg/api` rather than importing `@gtg/domain`
 * directly (see the IMPORT RULE in index.ts). This module is the storefront's
 * and admin's only sanctioned way to know which schools GTG is licensed to sell.
 */

export {
  LICENSED_SCHOOLS,
  LICENSED_SCHOOL_CODES,
  isLicensedSchool,
  getLicensedSchoolCode,
  type LicensedSchool,
} from '@gtg/domain'
