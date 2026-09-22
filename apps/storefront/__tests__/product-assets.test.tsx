import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FEATURED_SHOWCASE_ITEMS } from '../src/config/featured-product-art'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('featured product assets', () => {
  it.each(FEATURED_SHOWCASE_ITEMS)('$name has a deployable PNG in public/', ({ assetPath }) => {
    const relativePath = assetPath.split('?')[0]?.replace(/^\//, '')
    expect(relativePath).toBeTruthy()

    const bytes = readFileSync(resolve(process.cwd(), 'apps/storefront/public', relativePath as string))
    expect(bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE)
  })
})
