import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ADMIN_ROLES, ALL_ROLES, verifyRole } from '../_shared/auth.ts'

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('edge auth role policies', () => {
  it('verifyRole grants admin for ADMIN_ROLES', () => {
    const req = new Request('http://localhost/functions/v1/test')
    const user = { id: 'u1', app_metadata: { role: 'admin' } }
    const result = verifyRole(user, ADMIN_ROLES, req)

    expect(result.denied).toBeNull()
    expect(result.authorized?.role).toBe('admin')
  })

  it('verifyRole denies consultant for ADMIN_ROLES', () => {
    const req = new Request('http://localhost/functions/v1/test')
    const user = { id: 'u1', app_metadata: { role: 'consultant' } }
    const result = verifyRole(user, ADMIN_ROLES, req)

    expect(result.authorized).toBeNull()
    expect(result.denied?.status).toBe(403)
  })

  it('verifyRole allows consultant for ALL_ROLES', () => {
    const req = new Request('http://localhost/functions/v1/test')
    const user = { id: 'u1', app_metadata: { role: 'consultant' } }
    const result = verifyRole(user, ALL_ROLES, req)

    expect(result.denied).toBeNull()
    expect(result.authorized?.role).toBe('consultant')
  })

  it('verifyRole accepts ReadonlySet role collections', () => {
    const req = new Request('http://localhost/functions/v1/test')
    const user = { id: 'u1', app_metadata: { role: 'admin' } }
    const result = verifyRole(user, new Set(['admin']), req)

    expect(result.denied).toBeNull()
    expect(result.authorized?.role).toBe('admin')
  })

  it('admin endpoint create-product uses ADMIN_ROLES', () => {
    const createProductSource = source('supabase/functions/create-product/index.ts')
    expect(createProductSource).toContain('verifyRole(user, ADMIN_ROLES, req)')
  })

  it('consultant endpoint get-referral-link includes consultant role', () => {
    const referralSource = source('supabase/functions/get-referral-link/index.ts')
    expect(referralSource).toContain("verifyRole(user, [...ADMIN_ROLES, 'consultant'], req)")
  })

  it('public endpoint verify-serial does not require verifyRole', () => {
    const verifySerialSource = source('supabase/functions/verify-serial/index.ts')
    expect(verifySerialSource).not.toContain('verifyRole(')
  })

  it('process-order-ledger uses decomposed phase-4 step modules', () => {
    const ledgerSource = source('supabase/functions/process-order-ledger/index.ts')

    expect(ledgerSource).toContain("from './steps/validate-order.ts'")
    expect(ledgerSource).toContain("from './steps/reserve-inventory.ts'")
    expect(ledgerSource).toContain("from './steps/record-ledger.ts'")
    expect(ledgerSource).toContain("from './steps/compute-commission.ts'")
    expect(ledgerSource).toContain("from './steps/apply-royalty.ts'")
    expect(ledgerSource).toContain("from './steps/finalize-order.ts'")
  })
})
