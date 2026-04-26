import type { CustomerAddress } from '@gtg/types'
import { ApiRequestError } from './error'
import { getAuthSession } from './auth'
import { getTableClient } from './transport'
import type { Database } from './transport'

type CustomerProfileRow = Database['public']['Tables']['customer_profiles']['Row']
type OrderRow = Database['public']['Tables']['orders']['Row']

export interface UpdateMyCustomerProfileInput {
  fullName?: string | null
  phone?: string | null
  defaultShippingAddress?: CustomerAddress | null
  marketingEmailOptIn?: boolean
}

export interface CustomerOrderSummary {
  id: string
  orderNumber: string
  status: OrderRow['status']
  channel: OrderRow['channel']
  totalCents: number
  createdAt: string
  paidAt: string | null
  fulfilledAt: string | null
  productCount: number
}

function normalizeNullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

async function requireCurrentUser(callerName: string): Promise<{ id: string; email: string | null }> {
  const session = await getAuthSession()
  const user = session?.user

  if (!user) {
    throw new ApiRequestError(
      `[GTG] ${callerName}(): an authenticated customer session is required.`,
      'VALIDATION_ERROR',
    )
  }

  return {
    id: user.id,
    email: typeof user.email === 'string' ? user.email.trim().toLowerCase() : null,
  }
}

export async function getMyCustomerProfile(): Promise<CustomerProfileRow | null> {
  const client = getTableClient()
  const { data, error } = await client
    .from('customer_profiles')
    .select('*')
    .maybeSingle()

  if (error) {
    throw new ApiRequestError(
      `[GTG] getMyCustomerProfile(): query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  return (data ?? null) as CustomerProfileRow | null
}

export async function saveMyCustomerProfile(
  input: UpdateMyCustomerProfileInput,
): Promise<CustomerProfileRow> {
  const currentUser = await requireCurrentUser('saveMyCustomerProfile')

  const fullName = normalizeNullableString(input.fullName)
  const phone = normalizeNullableString(input.phone)
  const client = getTableClient()

  const payload: Database['public']['Tables']['customer_profiles']['Insert'] = {
    auth_user_id: currentUser.id,
    email: currentUser.email ?? '',
    ...(fullName !== undefined ? { full_name: fullName } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(input.defaultShippingAddress !== undefined
      ? {
          default_shipping_address:
            (input.defaultShippingAddress as unknown as Database['public']['Tables']['customer_profiles']['Insert']['default_shipping_address']),
        }
      : {}),
    ...(input.marketingEmailOptIn !== undefined
      ? { marketing_email_opt_in: input.marketingEmailOptIn }
      : {}),
  }

  const { data, error } = await client
    .from('customer_profiles')
    .upsert(payload, { onConflict: 'auth_user_id' })
    .select('*')
    .single()

  if (error || !data) {
    throw new ApiRequestError(
      `[GTG] saveMyCustomerProfile(): upsert failed: ${error?.message ?? 'missing row'}`,
      'QUERY_ERROR',
    )
  }

  return data as CustomerProfileRow
}

export async function listMyOrders(limit = 25): Promise<CustomerOrderSummary[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiRequestError(
      '[GTG] listMyOrders(): limit must be an integer between 1 and 100.',
      'VALIDATION_ERROR',
    )
  }

  const client = getTableClient()
  const { data, error } = await client
    .from('orders')
    .select('id, order_number, status, channel, total_cents, created_at, paid_at, fulfilled_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new ApiRequestError(
      `[GTG] listMyOrders(): query failed: ${error.message}`,
      'QUERY_ERROR',
    )
  }

  const orderIds = ((data ?? []) as Array<Pick<OrderRow, 'id'>>).map((row) => row.id)

  const countsByOrderId = new Map<string, number>()
  if (orderIds.length > 0) {
    const { data: linesData, error: linesError } = await client
      .from('order_lines')
      .select('order_id')
      .in('order_id', orderIds)

    if (linesError) {
      throw new ApiRequestError(
        `[GTG] listMyOrders(): order lines query failed: ${linesError.message}`,
        'QUERY_ERROR',
      )
    }

    for (const line of linesData ?? []) {
      const orderId = line.order_id
      countsByOrderId.set(orderId, (countsByOrderId.get(orderId) ?? 0) + 1)
    }
  }

  return ((data ?? []) as OrderRow[]).map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    channel: row.channel,
    totalCents: row.total_cents,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    productCount: countsByOrderId.get(row.id) ?? 0,
  }))
}
