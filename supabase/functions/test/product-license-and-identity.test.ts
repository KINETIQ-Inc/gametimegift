import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// create-product/edit-product both import _shared/supabase.ts, which uses
// Deno's `npm:` module specifiers (e.g. `npm:@supabase/supabase-js@^2`) —
// Vite/Vitest's resolver has no notion of that scheme, so these handler
// modules cannot be imported directly from a test the way _shared/*.ts
// helpers with no such import can (see auth-role-policies.test.ts). Source
// assertions are the established pattern here (see the same file's
// create-product/process-order-ledger/verify-serial checks) — this test
// pins the exact validation strings so any accidental removal or rewording
// of these compliance checks fails CI instead of silently disappearing.

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('create-product: CLC school validation cannot be bypassed', () => {
  const createProductSource = source('supabase/functions/create-product/index.ts')

  it('requires school whenever license_body is CLC, not just when school is provided', () => {
    expect(createProductSource).toContain(
      "body.license_body === 'CLC' && (body.school === undefined || !isLicensedSchool(body.school))",
    )
    expect(createProductSource).toContain("school is required when license_body is 'CLC'.")
  })

  it('validates a provided school against the licensed-schools allowlist for CLC products', () => {
    expect(createProductSource).toContain('is not on the licensed-schools allowlist for CLC products')
  })

  it('still requires a licensed school for APPAREL regardless of license_body', () => {
    expect(createProductSource).toContain(
      'school must be a licensed school when category is APPAREL (style_key is generated from it).',
    )
  })
})

describe('edit-product: CLC school validation and apparel identity are immutable', () => {
  const editProductSource = source('supabase/functions/edit-product/index.ts')

  it('fetches school, category, and style_key so identity checks have data to compare against', () => {
    expect(editProductSource).toContain(
      "select('id, sku, school, license_body, category, style_key, royalty_rate, cost_cents, retail_price_cents, is_active')",
    )
  })

  it('requires an effective licensed school whenever the effective license_body is CLC', () => {
    expect(editProductSource).toContain(
      'effectiveLicenseBody === \'CLC\' &&\n      (effectiveSchool === null || !isLicensedSchool(effectiveSchool))',
    )
    expect(editProductSource).toContain("school is required when license_body is 'CLC'.")
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
