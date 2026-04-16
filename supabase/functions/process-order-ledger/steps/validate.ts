import { createAdminClient } from '../../_shared/supabase.ts'
import type {
  SerializedUnitStepData,
  ValidateOrderData,
  ValidationError,
} from '../contracts.ts'

const ACTIVE_FRAUD_FLAG_STATUSES = new Set(['open', 'under_review', 'escalated'])
const REQUIRED_HOLOGRAM_FIELDS = ['hologramId', 'batchId', 'appliedAt', 'appliedBy'] as const

function buildInvokeHeaders(req: Request): Record<string, string> {
  const invokeHeaders: Record<string, string> = {
    'content-type': 'application/json',
  }

  const authHeader = req.headers.get('authorization')
  if (authHeader) invokeHeaders.authorization = authHeader

  const apiKeyHeader = req.headers.get('apikey')
  if (apiKeyHeader) invokeHeaders.apikey = apiKeyHeader

  return invokeHeaders
}

export async function runValidateOrderStep(
  req: Request,
  orderId: string,
): Promise<{ ok: true; data: ValidateOrderData } | { ok: false; error: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is missing' }

  const validateResponse = await fetch(`${supabaseUrl}/functions/v1/validate-order`, {
    method: 'POST',
    headers: buildInvokeHeaders(req),
    body: JSON.stringify({ order_id: orderId }),
  })

  if (!validateResponse.ok) {
    const details = await validateResponse.text()
    return {
      ok: false,
      error: `validate-order invocation failed (${validateResponse.status}): ${details}`,
    }
  }

  const validateJson = await validateResponse.json() as { data?: ValidateOrderData }
  if (!validateJson.data) return { ok: false, error: 'validate-order returned malformed response' }

  return { ok: true, data: validateJson.data }
}

export async function runValidateOrderStepInternal(
  orderId: string,
): Promise<{ ok: true; data: ValidateOrderData } | { ok: false; error: string }> {
  const admin = createAdminClient()

  const { data: orderData, error: orderError } = await admin
    .from('orders')
    .select('id, order_number')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) {
    return { ok: false, error: `internal order lookup failed: ${orderError.message}` }
  }

  if (!orderData) {
    return { ok: false, error: `order ${orderId} not found` }
  }

  return {
    ok: true,
    data: {
      valid: true,
      order_id: orderData.id,
      order_number: orderData.order_number,
      errors: [],
    },
  }
}

export async function runValidateSerializedUnitsStep(
  req: Request,
  orderId: string,
): Promise<{ ok: true; data: SerializedUnitStepData } | { ok: false; error: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is missing' }

  const linesResponse = await fetch(`${supabaseUrl}/rest/v1/order_lines?select=id,unit_id,serial_number,status,serialized_units(status,order_id,serial_number,cost_cents,royalty_rate,hologram,fraud_flags(status,severity,source))&order_id=eq.${orderId}&status=neq.cancelled`, {
    method: 'GET',
    headers: buildInvokeHeaders(req),
  })

  if (!linesResponse.ok) {
    const details = await linesResponse.text()
    return {
      ok: false,
      error: `order lines query failed (${linesResponse.status}): ${details}`,
    }
  }

  const lines = await linesResponse.json() as Array<{
    id: string
    unit_id: string
    serial_number: string
    status: string
    serialized_units:
      | null
      | {
          status: string
          order_id: string | null
          serial_number: string
          cost_cents: number
          royalty_rate: number
          hologram: Record<string, unknown> | null
          fraud_flags: Array<{
            status: string
            severity: string
            source: string
          }> | null
        }
      | Array<{
          status: string
          order_id: string | null
          serial_number: string
          cost_cents: number
          royalty_rate: number
          hologram: Record<string, unknown> | null
          fraud_flags: Array<{
            status: string
            severity: string
            source: string
          }> | null
        }>
  }>

  const errors: ValidationError[] = []

  for (const line of lines) {
    const unit = Array.isArray(line.serialized_units)
      ? line.serialized_units[0]
      : line.serialized_units

    if (!unit) {
      errors.push({
        code: 'UNIT_NOT_FOUND',
        message: `Order line ${line.id} references missing unit ${line.unit_id}.`,
      })
      continue
    }

    if (unit.serial_number !== line.serial_number) {
      errors.push({
        code: 'SERIAL_MISMATCH',
        message: `Order line ${line.id} serial mismatch (line=${line.serial_number}, unit=${unit.serial_number}).`,
      })
    }

    if (!['available', 'reserved'].includes(unit.status)) {
      errors.push({
        code: 'WRONG_STATUS',
        message: `Unit ${line.unit_id} has status '${unit.status}' and is not sellable.`,
      })
    }

    if (unit.status === 'reserved' && unit.order_id !== null && unit.order_id !== orderId) {
      errors.push({
        code: 'RESERVED_DIFFERENT_ORDER',
        message: `Unit ${line.unit_id} is reserved to a different order (${unit.order_id}).`,
      })
    }

    if (unit.cost_cents <= 0) {
      errors.push({
        code: 'ZERO_COST',
        message: `Unit ${line.unit_id} has invalid cost_cents=${unit.cost_cents}.`,
      })
    }

    if (unit.royalty_rate < 0 || unit.royalty_rate > 1) {
      errors.push({
        code: 'INVALID_ROYALTY_RATE',
        message: `Unit ${line.unit_id} has invalid royalty_rate=${unit.royalty_rate}.`,
      })
    }

    if (unit.hologram === null) {
      errors.push({
        code: 'NO_HOLOGRAM',
        message: `Unit ${line.unit_id} is missing an applied hologram record.`,
      })
    } else {
      for (const field of REQUIRED_HOLOGRAM_FIELDS) {
        const value = unit.hologram[field]
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push({
            code: 'INCOMPLETE_HOLOGRAM',
            message: `Unit ${line.unit_id} hologram.${field} is missing or empty.`,
          })
        }
      }
    }

    const flags = Array.isArray(unit.fraud_flags) ? unit.fraud_flags : []
    const activeFlags = flags.filter((f) => ACTIVE_FRAUD_FLAG_STATUSES.has(f.status))

    if (activeFlags.length > 0) {
      const summary = activeFlags.map((f) => `${f.status}/${f.severity} (${f.source})`).join(', ')
      errors.push({
        code: 'ACTIVE_FRAUD_FLAG',
        message: `Unit ${line.unit_id} has ${activeFlags.length} active fraud flag(s): ${summary}.`,
      })
    }
  }

  return {
    ok: true,
    data: {
      valid: errors.length === 0,
      line_count: lines.length,
      error_count: errors.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  }
}
