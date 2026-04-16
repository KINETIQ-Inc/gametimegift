interface LoggerLike {
  warn: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, context?: Record<string, unknown>) => void
}

interface RpcResponse {
  error: { message: string } | null
}

interface DeleteResponse {
  error: { message: string } | null
}

interface CleanupAdminClient {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResponse>
  from: (table: 'orders') => {
    delete: () => {
      eq: (column: string, value: string) => {
        eq: (nextColumn: string, nextValue: string) => Promise<DeleteResponse>
      }
    }
  }
}

interface CleanupFailedCheckoutInput {
  admin: CleanupAdminClient
  unitId: string
  orderId: string
  releasedBy: string
  log: LoggerLike
  context: Record<string, unknown>
}

export async function cleanupFailedCheckoutAttempt({
  admin,
  unitId,
  orderId,
  releasedBy,
  log,
  context,
}: CleanupFailedCheckoutInput): Promise<void> {
  const { error: releaseError } = await admin.rpc('release_reserved_unit', {
    p_unit_id: unitId,
    p_order_id: orderId,
    p_released_by: releasedBy,
    p_reason: 'Checkout session creation failed before payment could begin.',
  })

  if (releaseError !== null) {
    log.error('Failed to release reserved unit after checkout failure', {
      unit_id: unitId,
      order_id: orderId,
      error: releaseError.message,
      ...context,
    })
    return
  }

  log.warn('Released reserved unit after checkout failure', {
    unit_id: unitId,
    order_id: orderId,
    ...context,
  })

  const { error: deleteOrderError } = await admin
    .from('orders')
    .delete()
    .eq('id', orderId)
    .eq('status', 'pending_payment')

  if (deleteOrderError !== null) {
    log.error('Failed to delete pending order after checkout failure cleanup', {
      order_id: orderId,
      error: deleteOrderError.message,
      ...context,
    })
    return
  }

  log.warn('Deleted pending order after checkout failure cleanup', {
    order_id: orderId,
    ...context,
  })
}
