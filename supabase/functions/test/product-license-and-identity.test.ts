import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { validateClcSchool } from '../_shared/licensed-schools.ts'

// create-product/edit-product/assign-product-license all import
// _shared/supabase.ts, which uses Deno's `npm:` module specifier syntax —
// Vite/Vitest's resolver can't load that at all, so (unlike _shared/*.ts
// helpers with no such import, e.g. validateClcSchool below) these handler
// modules can't be imported directly into a test the way auth-role-policies
// .test.ts imports _shared/auth.ts. Source assertions are this file's own
// established pattern for that case (see its create-product/
// process-order-ledger/verify-serial checks) — they pin the exact call site
// so removing the shared-validator call, or reverting to a re-inlined,
// divergent copy of it, fails CI instead of silently regressing.

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('validateClcSchool (shared by create-product, edit-product, assign-product-license)', () => {
  it('passes non-CLC bodies through regardless of school', () => {
    expect(validateClcSchool('NONE', null)).toBeNull()
    expect(validateClcSchool('ARMY', null)).toBeNull()
    expect(validateClcSchool('NONE', 'Florida State University')).toBeNull()
  })

  it('rejects CLC with no school at all', () => {
    expect(validateClcSchool('CLC', null)).toMatch(/school is required when license_body is 'CLC'/)
    expect(validateClcSchool('CLC', undefined)).toMatch(/school is required when license_body is 'CLC'/)
  })

  it('rejects CLC with a school not on the licensed-schools allowlist', () => {
    expect(validateClcSchool('CLC', 'Florida State University')).toMatch(
      /not on the licensed-schools allowlist/,
    )
  })

  it('accepts CLC with a licensed school', () => {
    expect(validateClcSchool('CLC', 'University of Florida')).toBeNull()
  })
})

describe('every code path that can set license_body = CLC uses the shared validator', () => {
  const createProductSource = source('supabase/functions/create-product/index.ts')
  const editProductSource = source('supabase/functions/edit-product/index.ts')
  const assignLicenseSource = source('supabase/functions/assign-product-license/index.ts')

  it('create-product calls validateClcSchool instead of a re-inlined copy', () => {
    expect(createProductSource).toContain(
      "import { isLicensedSchool, validateClcSchool } from '../_shared/licensed-schools.ts'",
    )
    expect(createProductSource).toContain('validateClcSchool(body.license_body, body.school)')
  })

  it('edit-product calls validateClcSchool with the effective (post-update) school', () => {
    expect(editProductSource).toContain(
      "import { validateClcSchool } from '../_shared/licensed-schools.ts'",
    )
    expect(editProductSource).toContain('validateClcSchool(effectiveLicenseBody, effectiveSchool)')
  })

  it('assign-product-license calls validateClcSchool — this was the actual bypass', () => {
    // This endpoint can set license_body = 'CLC' without ever accepting
    // `school` in its own request body, so it must check the *existing*
    // row's school against the same shared rule create-product/edit-product
    // use, or a product could be assigned CLC with no licensed school at all.
    expect(assignLicenseSource).toContain(
      "import { validateClcSchool } from '../_shared/licensed-schools.ts'",
    )
    expect(assignLicenseSource).toContain('validateClcSchool(body.license_body, current.school)')
  })
})

describe('edit-product: apparel identity (style_key/school/category) is immutable', () => {
  const editProductSource = source('supabase/functions/edit-product/index.ts')

  it('fetches school, category, and style_key so identity checks have data to compare against', () => {
    expect(editProductSource).toContain(
      "select('id, sku, school, license_body, category, size, style_key, royalty_rate, cost_cents, retail_price_cents, is_active')",
    )
  })

  it('rejects changing school on a product that already has a style_key', () => {
    expect(editProductSource).toContain(
      'school cannot be changed for an apparel product once its style_key',
    )
  })

  it('rejects changing category once a style_key has been generated', () => {
    expect(editProductSource).toContain('apparel identity is permanent')
  })

  it('rejects switching category to APPAREL after creation (no retroactive style_key generation)', () => {
    expect(editProductSource).toContain('category cannot be changed to APPAREL after creation')
  })
})

describe('duplicate apparel variants (style_key + size + color) are rejected, not silently created', () => {
  const createProductSource = source('supabase/functions/create-product/index.ts')
  const editProductSource = source('supabase/functions/edit-product/index.ts')
  const migrationSource = source(
    'supabase/migrations/20260921000100_add_apparel_category_to_products.sql',
  )

  it('the migration adds a unique index on (style_key, size, color) for APPAREL rows', () => {
    expect(migrationSource).toContain('create unique index products_apparel_variant_unique')
    expect(migrationSource).toContain('on public.products (style_key, size, (coalesce(color, \'\')))')
    expect(migrationSource).toContain("where category = 'APPAREL' and style_key is not null")
  })

  it('create-product surfaces the constraint violation as a clear 409, not a generic 500', () => {
    expect(createProductSource).toContain("insertError.message.includes('products_apparel_variant_unique')")
    expect(createProductSource).toContain('Each size/color combination may only be represented by one product')
  })

  it('edit-product surfaces the same constraint violation when a color edit collides with a sibling', () => {
    expect(editProductSource).toContain("updateError.message.includes('products_apparel_variant_unique')")
    expect(editProductSource).toContain('Each size/color combination may only be represented by one product')
  })
})
