import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// create-order, create-checkout-session, and check-availability each query
// the `products` table directly (not through list-products). All three had
// been left querying columns that don't exist on the real schema —
// `license_type`, `price`, and `active` instead of `license_body`,
// `retail_price_cents`, and `is_active` (see
// supabase/migrations/20260305000001_create_products.sql) — the exact same
// root cause already documented and fixed in list-products/index.ts's own
// history. Every one of these queries would 500 on every real invocation,
// meaning checkout could never actually complete. These handlers import
// _shared/supabase.ts's `npm:` specifiers, which Vitest can't resolve, so
// this is a source assertion (this file's established pattern for that
// constraint) pinning the correct column names so a regression back to the
// old ones fails CI immediately.

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('checkout-critical functions query real products columns, not stale ones', () => {
  const files = [
    'supabase/functions/create-order/index.ts',
    'supabase/functions/create-checkout-session/index.ts',
    'supabase/functions/check-availability/index.ts',
  ]

  it.each(files)('%s selects is_active, never the nonexistent active/license_type/price columns', (file) => {
    const src = source(file)
    expect(src).toContain('is_active')
    expect(src).not.toContain('license_type')
    expect(src).not.toContain('retail_price_cents:price')
    expect(src).not.toMatch(/\.eq\(['"]active['"]/)
  })
})
