import { readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const siteUrl = requiredUrl('GTG_SITE_URL')
const supabaseUrl = requiredUrl('GTG_SUPABASE_URL')
const anonKey = required('GTG_SUPABASE_ANON_KEY')
const expectedCommit = required('GTG_EXPECTED_COMMIT').toLowerCase()
const timeoutMs = positiveInteger(process.env.GTG_SMOKE_TIMEOUT_MS ?? '180000')
const retryMs = positiveInteger(process.env.GTG_SMOKE_RETRY_MS ?? '5000')

if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  throw new Error('GTG_EXPECTED_COMMIT must be a full 40-character commit SHA.')
}

const pngDirectory = resolve('apps/storefront/public/assets/products')
const pngFiles = (await readdir(pngDirectory))
  .filter((name) => name.toLowerCase().endsWith('.png'))
  .sort()

if (pngFiles.length === 0) {
  throw new Error(`No product PNG files found under ${pngDirectory}.`)
}

await retry('storefront release metadata', async () => {
  const response = await fetch(new URL('/release.json', siteUrl), {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  assertStatus(response, 'release metadata')
  const payload = await response.json()
  if (payload?.commit !== expectedCommit) {
    throw new Error(`expected commit ${expectedCommit}, received ${String(payload?.commit)}`)
  }
})

await retry('storefront HTML', async () => {
  const response = await fetch(siteUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  assertStatus(response, 'storefront HTML')
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) {
    throw new Error(`unexpected content type ${contentType}`)
  }
})

await retry('catalog Edge Function', async () => {
  const response = await fetch(new URL('/functions/v1/list-products', supabaseUrl), {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 1, offset: 0 }),
    signal: AbortSignal.timeout(15_000),
  })
  assertStatus(response, 'catalog Edge Function')
  const payload = await response.json()
  if (!Array.isArray(payload?.data?.products)) {
    throw new Error('response does not contain data.products array')
  }
  if (payload.data.products.length === 0) {
    throw new Error('catalog returned zero products')
  }

  const product = payload.data.products[0]
  for (const field of ['id', 'sku', 'name', 'retail_price_cents']) {
    if (product[field] === undefined || product[field] === null) {
      throw new Error(`catalog product is missing ${field}`)
    }
  }
})

for (const pngFile of pngFiles) {
  const localBytes = await readFile(resolve(pngDirectory, pngFile))
  assertPngSignature(localBytes, `local ${pngFile}`)

  await retry(`product asset ${pngFile}`, async () => {
    const response = await fetch(new URL(`/assets/products/${basename(pngFile)}`, siteUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    assertStatus(response, pngFile)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('image/png')) {
      throw new Error(`unexpected content type ${contentType}`)
    }
    assertPngSignature(Buffer.from(await response.arrayBuffer()), `deployed ${pngFile}`)
  })
}

console.log(`Production smoke passed for ${siteUrl.href} at commit ${expectedCommit}.`)

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function requiredUrl(name) {
  const value = new URL(required(name))
  if (value.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`)
  return value
}

function positiveInteger(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`)
  }
  return parsed
}

function assertStatus(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
}

function assertPngSignature(bytes, label) {
  const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < expected.length || expected.some((byte, index) => bytes[index] !== byte)) {
    throw new Error(`${label} is not a valid PNG file.`)
  }
}

async function retry(label, operation) {
  const deadline = Date.now() + timeoutMs
  let lastError

  while (Date.now() < deadline) {
    try {
      await operation()
      console.log(`PASS ${label}`)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryMs))
    }
  }

  throw new Error(`${label} did not become healthy within ${timeoutMs}ms: ${lastError?.message}`)
}
