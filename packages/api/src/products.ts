import type { LicenseBody, ProductCategory, ApparelSize, ProductLifecycleStatus } from '@gtg/types'
import { generateStyleKey as domainGenerateStyleKey, type GarmentType } from '@gtg/domain'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction } from './transport'

const VALID_LICENSE_BODIES: LicenseBody[] = ['CLC', 'ARMY', 'NONE']

// ─── Apparel Style Key Generation ──────────────────────────────────────────────
// Re-exported from @gtg/domain — see docs/adr/0001-style-key-immutability.md.
// This is the only sanctioned way to produce a style_key; admins never type
// one by hand.

export const generateStyleKey = domainGenerateStyleKey
export type { GarmentType, ProductCategory, ApparelSize, ProductLifecycleStatus }
export { GARMENT_TYPES, APPAREL_SIZE_ORDER } from '@gtg/domain'

export interface ProductListItem {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: LicenseBody
  category: ProductCategory
  lifecycle_status: ProductLifecycleStatus
  size: ApparelSize | null
  color: string | null
  style_key: string | null
  retail_price_cents: number
  available_count: number
  in_stock: boolean
  created_at: string
  updated_at: string
}

export interface ListProductsInput {
  search?: string
  school?: string
  license_body?: LicenseBody | LicenseBody[]
  category?: ProductCategory
  style_key?: string
  limit?: number
  offset?: number
}

export interface ListProductsResult {
  products: ProductListItem[]
  total: number
  limit: number
  offset: number
}

type DirectProductRow = {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: LicenseBody
  category: ProductCategory
  lifecycle_status: ProductLifecycleStatus
  size: ApparelSize | null
  color: string | null
  style_key: string | null
  retail_price_cents: number
  created_at: string
  updated_at: string
}

export interface CreateProductInput {
  sku: string
  name: string
  description?: string
  school?: string
  license_body: LicenseBody
  /** Defaults to 'COLLECTIBLE' server-side when omitted. */
  category?: ProductCategory
  /** Required when category is 'APPAREL'. Ignored for 'COLLECTIBLE'. */
  size?: ApparelSize
  /** Optional even for 'APPAREL'. Ignored for 'COLLECTIBLE'. */
  color?: string
  /**
   * Required when category is 'APPAREL' (combined with `school` to compute
   * style_key server-side via generateStyleKey — see docs/adr/0001). Never
   * submit a `style_key` directly; there is no such field on this input.
   */
  garment_type?: GarmentType
  royalty_rate?: number
  cost_cents: number
  retail_price_cents: number
}

export interface ProductRecord {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: LicenseBody
  category: ProductCategory
  lifecycle_status: ProductLifecycleStatus
  size: ApparelSize | null
  color: string | null
  style_key: string | null
  royalty_rate: number | null
  cost_cents: number
  retail_price_cents: number
  is_active: boolean
  created_at: string
  updated_at: string
  created_by: string
}

export interface UpdateProductInput {
  product_id: string
  name?: string
  description?: string | null
  school?: string | null
  license_body?: LicenseBody
  /** style_key is immutable and cannot be patched — see docs/adr/0001. */
  category?: ProductCategory
  color?: string | null
  lifecycle_status?: ProductLifecycleStatus
  royalty_rate?: number | null
  cost_cents?: number
  retail_price_cents?: number
  is_active?: boolean
}

export interface AssignProductLicenseInput {
  product_id: string
  license_body: LicenseBody
  royalty_rate?: number | null
}

export interface AssignProductLicenseHolder {
  id: string
  legal_name: string
  code: string
  default_royalty_rate: number
  minimum_royalty_cents: number | null
  reporting_period: string
}

export interface AssignProductLicenseResult {
  product_id: string
  sku: string
  license_body: LicenseBody
  royalty_rate: number | null
  effective_rate: number | null
  license_holder: AssignProductLicenseHolder | null
}

function assertLicenseBody(value: string, fnName: string): asserts value is LicenseBody {
  if (!VALID_LICENSE_BODIES.includes(value as LicenseBody)) {
    throw new ApiRequestError(
      `[GTG] ${fnName}(): license_body must be one of CLC, ARMY, NONE.`,
      'VALIDATION_ERROR',
    )
  }
}

export async function listProducts(input: ListProductsInput = {}): Promise<ListProductsResult> {
  return invokeFunction<ListProductsResult>('list-products', input as unknown as Record<string, unknown>, 'listProducts')
}

// This fallback reads the `products` table directly with the browser's
// anon-key client, for when the list-products Edge Function itself is
// unreachable. It must apply the SAME filters as that function (never
// broaden what the caller asked for) and must NEVER fabricate stock: the
// real availability join (get_available_unit_counts) is granted to
// service_role only — see
// supabase/migrations/20260305000035_get_available_unit_counts_fn.sql — so
// this anon-key client cannot legally call it. Reporting unknown
// availability as available would be actively misleading (a shopper could
// "buy" something with zero real stock); every row here is honestly
// unavailable until list-products itself is reachable again.
async function listProductsDirectly(input: ListProductsInput): Promise<ListProductsResult> {
  const client = getTableClient()
  const limit = input.limit ?? 50
  const offset = input.offset ?? 0

  let query = client
    .from('products')
    .select(
      'id, sku, name, description, school, license_body, category, lifecycle_status, ' +
      'size, color, style_key, retail_price_cents, created_at, updated_at',
      { count: 'exact' },
    )
    .eq('is_active', true)
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1)

  if (input.license_body !== undefined) {
    const bodies = Array.isArray(input.license_body) ? input.license_body : [input.license_body]
    const [firstBody] = bodies
    query = bodies.length === 1 && firstBody !== undefined
      ? query.eq('license_body', firstBody)
      : query.in('license_body', bodies)
  }
  if (input.search !== undefined) {
    query = query.ilike('name', `%${input.search.trim()}%`)
  }
  if (input.school !== undefined) {
    query = query.eq('school', input.school.trim())
  }
  if (input.category !== undefined) {
    query = query.eq('category', input.category)
  }
  if (input.style_key !== undefined) {
    query = query.eq('style_key', input.style_key.trim())
  }

  const { data, error, count } = await query

  if (error) {
    throw new ApiRequestError(
      `[GTG] listProductsWithFallback(): direct query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  const products: ProductListItem[] = ((data ?? []) as DirectProductRow[]).map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    school: product.school,
    license_body: product.license_body,
    category: product.category,
    lifecycle_status: product.lifecycle_status,
    size: product.size,
    color: product.color,
    style_key: product.style_key,
    retail_price_cents: product.retail_price_cents,
    // Never fabricated — see the function comment. Real availability is
    // unknown from this path, and unknown must never be presented as "in
    // stock" or "1 available."
    available_count: 0,
    in_stock: false,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }))

  return {
    products,
    total: count ?? products.length,
    limit,
    offset,
  }
}

export async function listProductsWithFallback(
  input: ListProductsInput = {},
): Promise<ListProductsResult> {
  // A successful, filtered, genuinely empty result ("no products match
  // school=X") is a valid answer, not a failure — falling back to an
  // unfiltered direct query in that case would broaden the result set behind
  // the caller's back. The fallback only exists for when list-products
  // itself could not be reached at all.
  try {
    return await listProducts(input)
  } catch {
    return listProductsDirectly(input)
  }
}

export async function createProduct(input: CreateProductInput): Promise<ProductRecord> {
  const { sku, name, license_body, category, size, garment_type } = input

  if (!sku || !name) {
    throw new ApiRequestError(
      '[GTG] createProduct(): sku and name are required.',
      'VALIDATION_ERROR',
    )
  }
  assertLicenseBody(license_body, 'createProduct')

  if (category === 'APPAREL' && garment_type === undefined) {
    throw new ApiRequestError(
      '[GTG] createProduct(): garment_type is required when category is APPAREL.',
      'VALIDATION_ERROR',
    )
  }
  if (category === 'COLLECTIBLE' && (size !== undefined || garment_type !== undefined)) {
    throw new ApiRequestError(
      '[GTG] createProduct(): size and garment_type must not be set when category is COLLECTIBLE.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ProductRecord>('create-product', input as unknown as Record<string, unknown>, 'createProduct')
}

export async function updateProduct(input: UpdateProductInput): Promise<ProductRecord> {
  const { product_id, license_body } = input

  if (!product_id) {
    throw new ApiRequestError(
      '[GTG] updateProduct(): product_id is required.',
      'VALIDATION_ERROR',
    )
  }
  assertUuidV4(product_id, 'product_id', 'updateProduct')

  if (license_body !== undefined) {
    assertLicenseBody(license_body, 'updateProduct')
  }

  return invokeFunction<ProductRecord>('edit-product', input as unknown as Record<string, unknown>, 'updateProduct')
}

export async function deactivateProduct(productId: string): Promise<ProductRecord> {
  return updateProduct({ product_id: productId, is_active: false })
}

export async function assignProductLicense(
  input: AssignProductLicenseInput,
): Promise<AssignProductLicenseResult> {
  const { product_id, license_body } = input

  if (!product_id) {
    throw new ApiRequestError(
      '[GTG] assignProductLicense(): product_id is required.',
      'VALIDATION_ERROR',
    )
  }
  assertUuidV4(product_id, 'product_id', 'assignProductLicense')
  assertLicenseBody(license_body, 'assignProductLicense')

  return invokeFunction<AssignProductLicenseResult>(
    'assign-product-license',
    input as unknown as Record<string, unknown>,
    'assignProductLicense',
  )
}
