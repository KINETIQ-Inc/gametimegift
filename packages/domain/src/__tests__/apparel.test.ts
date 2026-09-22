import { describe, expect, it } from 'vitest'
import { APPAREL_SIZE_ORDER, compareApparelSizes, generateStyleKey } from '../apparel'
import { isApparelSize, assertApparelSize, validateApparelFields } from '../product-categories'

describe('apparel size enum (approved sizes: S, M, L, XL, 2XL, 3XL)', () => {
  it('APPAREL_SIZE_ORDER contains exactly the six approved sizes, smallest to largest', () => {
    expect(APPAREL_SIZE_ORDER).toEqual(['S', 'M', 'L', 'XL', '2XL', '3XL'])
  })

  it('compareApparelSizes orders 2XL and 3XL above XL', () => {
    expect(compareApparelSizes('XL', '2XL')).toBeLessThan(0)
    expect(compareApparelSizes('2XL', '3XL')).toBeLessThan(0)
    expect(compareApparelSizes('3XL', 'S')).toBeGreaterThan(0)
  })

  it('isApparelSize accepts every approved size', () => {
    for (const size of APPAREL_SIZE_ORDER) {
      expect(isApparelSize(size)).toBe(true)
    }
  })

  it('isApparelSize rejects the old XXL value now that it has been replaced', () => {
    expect(isApparelSize('XXL')).toBe(false)
  })

  it('assertApparelSize throws for a value outside the approved set', () => {
    expect(() => assertApparelSize('XXL')).toThrow(/must be one of/)
  })
})

describe('generateStyleKey', () => {
  it('is deterministic for the same school + garment type', () => {
    const a = generateStyleKey('Clemson University', 'HOODIE')
    const b = generateStyleKey('Clemson University', 'HOODIE')
    expect(a).toBe(b)
    expect(a).toBe('APP-CLEMSON-HOODIE')
  })

  it('returns null for a school that is not licensed', () => {
    expect(generateStyleKey('Florida State University', 'HOODIE')).toBeNull()
  })
})

describe('validateApparelFields — style_key/size/color consistency (mirrors the DB check constraint)', () => {
  it('rejects a COLLECTIBLE that carries any apparel field', () => {
    expect(validateApparelFields('COLLECTIBLE', 'M', null, null)).toMatch(/must not be set/)
    expect(validateApparelFields('COLLECTIBLE', null, 'Navy', null)).toMatch(/must not be set/)
    expect(validateApparelFields('COLLECTIBLE', null, null, 'APP-CLEMSON-HOODIE')).toMatch(/must not be set/)
  })

  it('accepts a COLLECTIBLE with no apparel fields at all', () => {
    expect(validateApparelFields('COLLECTIBLE', null, null, null)).toBeNull()
  })

  it('rejects an APPAREL row missing a size', () => {
    expect(validateApparelFields('APPAREL', null, 'Navy', 'APP-CLEMSON-HOODIE')).toMatch(
      /size is required/,
    )
  })

  it('rejects an APPAREL row with a size outside the approved set', () => {
    expect(validateApparelFields('APPAREL', 'XXL', null, 'APP-CLEMSON-HOODIE')).toMatch(
      /size must be one of/,
    )
  })

  it('rejects an APPAREL row missing a style_key', () => {
    expect(validateApparelFields('APPAREL', 'M', null, null)).toMatch(/style_key is required/)
  })

  it('accepts a valid APPAREL row with an optional color', () => {
    expect(validateApparelFields('APPAREL', 'M', null, 'APP-CLEMSON-HOODIE')).toBeNull()
    expect(validateApparelFields('APPAREL', '2XL', 'Navy', 'APP-CLEMSON-HOODIE')).toBeNull()
  })
})
