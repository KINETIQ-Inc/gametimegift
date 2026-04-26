import type { LicenseBody } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction } from './transport'

const VALID_LICENSE_BODIES: LicenseBody[] = ['CLC', 'ARMY', 'NONE']

export interface ProductListItem {
  id: string
  sku: string
  name: string
  description: string | null
  school: string | null
  license_body: LicenseBody
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
  school: string | null
  sport: string | null
  license_body: LicenseBody
  retail_price_cents: number
  created_at: string
}

export interface CreateProductInput {
  sku: string
  name: string
  description?: string
  school?: string
  license_body: LicenseBody
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
  royalty_rate: number | null
  cost_cents: number
  retail_price_cents: number
  active: boolean
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
  royalty_rate?: number | null
  cost_cents?: number
  retail_price_cents?: number
  active?: boolean
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

async function listProductsDirectly(): Promise<ProductListItem[]> {
  const client = getTableClient()
  const { data, error } = await client
    .from('products')
    .select('id, sku, name, school, sport, license_body:license_type, retail_price_cents:price, created_at')
    .eq('active', true)
    .order('created_at', { ascending: false })

  if (error) {
    throw new ApiRequestError(
      `[GTG] listProductsWithFallback(): direct query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  return ((data ?? []) as DirectProductRow[]).map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.sport ? `${product.sport} collectible` : null,
    school: product.school,
    license_body: product.license_body,
    retail_price_cents: product.retail_price_cents,
    available_count: 1,
    in_stock: true,
    created_at: product.created_at,
    updated_at: product.created_at,
  }))
}

export async function listProductsWithFallback(
  input: ListProductsInput = {},
): Promise<ListProductsResult> {
  try {
    const result = await listProducts(input)
    if (result.products.length > 0) {
      return result
    }

    const products = await listProductsDirectly()
    return {
      products,
      total: products.length,
      limit: input.limit ?? products.length,
      offset: input.offset ?? 0,
    }
  } catch {
    const products = await listProductsDirectly()
    return {
      products,
      total: products.length,
      limit: input.limit ?? products.length,
      offset: input.offset ?? 0,
    }
  }
}

export async function createProduct(input: CreateProductInput): Promise<ProductRecord> {
  const { sku, name, license_body } = input

  if (!sku || !name) {
    throw new ApiRequestError(
      '[GTG] createProduct(): sku and name are required.',
      'VALIDATION_ERROR',
    )
  }
  assertLicenseBody(license_body, 'createProduct')

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
  return updateProduct({ product_id: productId, active: false })
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
