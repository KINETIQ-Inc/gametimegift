import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import {
  getTableClient,
  invokeFunction,
  invokeFunctionDirect,
  type InvokeFunctionOptions,
} from './transport'
import type { Database } from './transport'

type OrderRow = Database['public']['Tables']['orders']['Row']
type OrderLineRow = Database['public']['Tables']['order_lines']['Row']

function assertValidOrderId(orderId: string, fnName: string): void {
  assertUuidV4(orderId, 'orderId', fnName)
}

// ─── Submit Order ─────────────────────────────────────────────────────────────

export interface SubmitOrderInput {
  orderId: string
}

export interface SubmitOrderStepError {
  code: string
  message: string
}

export interface SubmitOrderStep {
  step: string
  success: boolean
  order_number?: string
  line_count?: number
  inserted_count?: number
  error_count?: number
  errors?: SubmitOrderStepError[]
}

export interface SubmitOrderResult {
  phase: string
  pipeline: 'processOrderLedger'
  order_id: string
  success: boolean
  status: 'completed' | 'failed'
  failed_step?: string
  completed_steps: number
  total_steps: number
  steps: SubmitOrderStep[]
  errors: SubmitOrderStepError[]
}

async function invokeProcessOrderLedger(input: SubmitOrderInput): Promise<SubmitOrderResult> {
  const { orderId } = input

  if (!orderId || typeof orderId !== 'string') {
    throw new ApiRequestError('[GTG] processOrderLedger(): orderId is required.', 'VALIDATION_ERROR')
  }
  assertValidOrderId(orderId, 'processOrderLedger')

  return invokeFunctionDirect<SubmitOrderResult>(
    'process-order-ledger',
    { order_id: orderId },
    'processOrderLedger',
  )
}

/**
 * Submit an order to the server-side ledger pipeline.
 *
 * The frontend-safe entrypoint for order finalization. Never writes database
 * tables directly — all financial logic executes server-side in the
 * process-order-ledger Edge Function.
 *
 * process-order-ledger returns its result at the top level (no envelope),
 * so this uses invokeFunctionDirect.
 */
export async function submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
  return invokeProcessOrderLedger(input)
}

/**
 * Explicit alias for the ledger pipeline entrypoint.
 *
 * Phase 2 naming keeps storefront/order code aligned with the business flow:
 * createOrder() → processOrderLedger().
 */
export async function processOrderLedger(input: SubmitOrderInput): Promise<SubmitOrderResult> {
  return invokeProcessOrderLedger(input)
}

// ─── Fetch Order By ID ────────────────────────────────────────────────────────

export interface FetchOrderByIdInput {
  orderId: string
  includeLines?: boolean
}

export interface FetchOrderByIdResult {
  order: OrderRow
  lines: OrderLineRow[]
}

/**
 * Fetch an order by ID through the API wrapper layer.
 *
 * Returns null when the order does not exist or is not visible to the current
 * authenticated user under RLS.
 */
export async function fetchOrderById(
  input: FetchOrderByIdInput,
): Promise<FetchOrderByIdResult | null> {
  const { orderId, includeLines = true } = input

  if (!orderId || typeof orderId !== 'string') {
    throw new ApiRequestError('[GTG] fetchOrderById(): orderId is required.', 'VALIDATION_ERROR')
  }
  assertValidOrderId(orderId, 'fetchOrderById')

  const client = getTableClient()

  const { data: orderData, error: orderError } = await client
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) {
    throw new ApiRequestError(
      `[GTG] fetchOrderById(): order query failed: ${orderError.message}`,
      'QUERY_ERROR',
    )
  }

  const order = (orderData ?? null) as OrderRow | null
  if (!order) return null

  if (!includeLines) return { order, lines: [] }

  const { data: linesData, error: linesError } = await client
    .from('order_lines')
    .select('*')
    .eq('order_id', orderId)
    .order('line_number', { ascending: true })

  if (linesError) {
    throw new ApiRequestError(
      `[GTG] fetchOrderById(): order lines query failed: ${linesError.message}`,
      'QUERY_ERROR',
    )
  }

  return {
    order,
    lines: (linesData ?? []) as OrderLineRow[],
  }
}

// ─── Create Checkout Session ──────────────────────────────────────────────────

export interface CreateCheckoutSessionInput {
  productId: string
  /**
   * Always 1 for serialized collectibles — each unit has a unique hologram
   * serial number and cannot be bundled. Included in the schema so callers
   * are explicit about order intent; the Edge Function ignores values > 1.
   */
  quantity?: 1
  customerName: string
  customerEmail: string
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  consultantId?: string
  discountCode?: string
}

export interface CreateCheckoutSessionResult {
  order_id: string
  order_number: string
  session_id: string
  session_url: string
  unit_id: string
  serial_number: string
  product_id: string
  sku: string
  product_name: string
  channel: 'storefront_direct' | 'consultant_assisted'
}

export interface OrderAddress {
  line1: string
  line2?: string | null
  city: string
  state: string
  postalCode: string
  country?: string
}

export type OrderAddon = 'roses_carnations' | 'roses_only' | 'humidor'

export interface CreateOrderInput {
  productId: string
  quantity?: 1
  customerName: string
  customerEmail: string
  idempotencyKey: string
  consultantId?: string
  discountCode?: string
  shippingAddress?: OrderAddress
  addons?: OrderAddon[]
  giftRecipient?: string
  giftOccasion?: string
  giftNote?: string
}

export interface CreateOrderResult {
  order_id: string
  order_number: string
  payment_intent_id: string
  client_secret: string
  total_cents: number
  unit_id: string
  serial_number: string
  product_id: string
  sku: string
  product_name: string
  channel: 'storefront_direct' | 'consultant_assisted'
}

async function invokeCreateCheckoutSession(
  input: CreateCheckoutSessionInput,
  options?: InvokeFunctionOptions,
): Promise<CreateCheckoutSessionResult> {
  const { productId, customerName, customerEmail, successUrl, cancelUrl, idempotencyKey, consultantId, discountCode } =
    input

  if (!productId || typeof productId !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): productId is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!customerName || typeof customerName !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): customerName is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!customerEmail || typeof customerEmail !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): customerEmail is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!successUrl || typeof successUrl !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): successUrl is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!cancelUrl || typeof cancelUrl !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): cancelUrl is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new ApiRequestError(
      '[GTG] createCheckoutSession(): idempotencyKey is required.',
      'VALIDATION_ERROR',
    )
  }

  assertUuidV4(productId, 'productId', 'createCheckoutSession')
  if (consultantId) {
    assertUuidV4(consultantId, 'consultantId', 'createCheckoutSession')
  }

  return invokeFunction<CreateCheckoutSessionResult>(
    'create-checkout-session',
    {
      product_id: productId,
      customer_name: customerName.trim(),
      customer_email: customerEmail.trim().toLowerCase(),
      success_url: successUrl,
      cancel_url: cancelUrl,
      idempotency_key: idempotencyKey.trim(),
      ...(consultantId ? { consultant_id: consultantId } : {}),
      ...(discountCode ? { discount_code: discountCode.trim().toUpperCase() } : {}),
    },
    'createCheckoutSession',
    options,
  )
}

async function invokeCreateOrder(
  input: CreateOrderInput,
  options?: InvokeFunctionOptions,
): Promise<CreateOrderResult> {
  const { productId, customerName, customerEmail, idempotencyKey, consultantId, discountCode, shippingAddress, addons, giftRecipient, giftOccasion, giftNote } =
    input

  if (!productId || typeof productId !== 'string') {
    throw new ApiRequestError(
      '[GTG] createOrder(): productId is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!customerName || typeof customerName !== 'string') {
    throw new ApiRequestError(
      '[GTG] createOrder(): customerName is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!customerEmail || typeof customerEmail !== 'string') {
    throw new ApiRequestError(
      '[GTG] createOrder(): customerEmail is required.',
      'VALIDATION_ERROR',
    )
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new ApiRequestError(
      '[GTG] createOrder(): idempotencyKey is required.',
      'VALIDATION_ERROR',
    )
  }

  assertUuidV4(productId, 'productId', 'createOrder')
  if (consultantId) {
    assertUuidV4(consultantId, 'consultantId', 'createOrder')
  }

  return invokeFunction<CreateOrderResult>(
    'create-order',
    {
      product_id: productId,
      quantity: 1,
      customer_name: customerName.trim(),
      customer_email: customerEmail.trim().toLowerCase(),
      idempotency_key: idempotencyKey.trim(),
      ...(consultantId ? { consultant_id: consultantId } : {}),
      ...(discountCode ? { discount_code: discountCode.trim().toUpperCase() } : {}),
      ...(shippingAddress ? {
        shipping_address: {
          line1: shippingAddress.line1,
          line2: shippingAddress.line2 ?? null,
          city: shippingAddress.city,
          state: shippingAddress.state,
          postal_code: shippingAddress.postalCode,
          country: shippingAddress.country ?? 'US',
        },
      } : {}),
      ...(addons && addons.length > 0 ? { addons } : {}),
      ...(giftRecipient ? { gift_recipient: giftRecipient } : {}),
      ...(giftOccasion ? { gift_occasion: giftOccasion } : {}),
      ...(giftNote ? { gift_note: giftNote } : {}),
    },
    'createOrder',
    options,
  )
}

/**
 * Create a Stripe checkout session and reserve one serialized unit.
 * Routes to the `create-checkout-session` Edge Function.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  options?: InvokeFunctionOptions,
): Promise<CreateCheckoutSessionResult> {
  return invokeCreateCheckoutSession(input, options)
}

/**
 * Phase 2 storefront-facing name for order initiation.
 *
 * The create-order business step now happens inside the checkout-session
 * function, which reserves inventory, creates the pending order record,
 * then hands off to Stripe.
 */
export async function createOrder(
  input: CreateOrderInput,
  options?: InvokeFunctionOptions,
): Promise<CreateOrderResult> {
  return invokeCreateOrder(input, options)
}
