import { createAdminClient } from '../../_shared/supabase.ts'
import type {
  CalculateCommissionStepData,
  ConsultantRateStepData,
  InsertCommissionLedgerStepData,
  ValidationError,
} from '../contracts.ts'

const COMMISSIONABLE_LINE_STATUSES = new Set(['reserved', 'shipped', 'delivered', 'returned'])
const HOLD_REASON_TAX =
  "Tax onboarding incomplete — commission withheld pending W-9 submission. " +
  "Release to 'earned' once consultant completes tax onboarding."

export async function runFetchConsultantRateStep(
  orderId: string,
): Promise<
  | { ok: true; data: ConsultantRateStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  const { data: orderData, error: orderError } = await admin
    .from('orders')
    .select('id, channel, consultant_id')
    .eq('id', orderId)
    .single()

  if (orderError || !orderData) {
    return {
      ok: false,
      kind: 'internal',
      error: `order lookup failed: ${orderError?.message ?? 'no row returned'}`,
    }
  }

  if (orderData.channel !== 'consultant_assisted') {
    return {
      ok: false,
      kind: 'precondition',
      error: `order ${orderId} channel is '${orderData.channel}', expected 'consultant_assisted'`,
    }
  }

  if (!orderData.consultant_id) {
    return { ok: false, kind: 'precondition', error: `order ${orderId} has no consultant_id` }
  }

  const consultantId = orderData.consultant_id as string

  const { data: consultant, error: consultantError } = await admin
    .from('consultant_profiles')
    .select(
      'id, legal_first_name, legal_last_name, commission_tier, custom_commission_rate, tax_onboarding_complete',
    )
    .eq('id', consultantId)
    .single()

  if (consultantError || !consultant) {
    return {
      ok: false,
      kind: 'internal',
      error: `consultant lookup failed: ${consultantError?.message ?? 'no row returned'}`,
    }
  }

  let effectiveRate: number

  if (consultant.commission_tier === 'custom') {
    if (consultant.custom_commission_rate === null) {
      return {
        ok: false,
        kind: 'precondition',
        error: `consultant ${consultant.id} has tier='custom' but custom_commission_rate is null`,
      }
    }
    effectiveRate = Number(consultant.custom_commission_rate)
  } else {
    const { data: tierConfig, error: tierError } = await admin
      .from('commission_tier_config')
      .select('rate')
      .eq('tier', consultant.commission_tier)
      .eq('is_active', true)
      .single()

    if (tierError || !tierConfig) {
      return {
        ok: false,
        kind: 'precondition',
        error: `no active commission tier config for '${consultant.commission_tier}'`,
      }
    }

    effectiveRate = Number(tierConfig.rate)
  }

  return {
    ok: true,
    data: {
      success: true,
      consultant_id: consultant.id,
      consultant_name: `${consultant.legal_first_name} ${consultant.legal_last_name}`.trim(),
      commission_tier: consultant.commission_tier,
      effective_rate: effectiveRate,
      tax_onboarding_complete: consultant.tax_onboarding_complete,
      commission_initial_status: consultant.tax_onboarding_complete ? 'earned' : 'held',
    },
  }
}

export async function runCalculateCommissionStep(
  orderId: string,
  effectiveRate: number,
): Promise<
  | { ok: true; data: CalculateCommissionStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  const { data: lines, error: linesError } = await admin
    .from('order_lines')
    .select(`
      id,
      unit_id,
      serial_number,
      sku,
      product_name,
      status,
      retail_price_cents,
      royalty_cents
    `)
    .eq('order_id', orderId)
    .neq('status', 'cancelled')

  if (linesError) {
    return {
      ok: false,
      kind: 'internal',
      error: `order lines lookup failed: ${linesError.message}`,
    }
  }

  const rows = lines ?? []

  if (rows.length === 0) {
    return {
      ok: false,
      kind: 'precondition',
      error: `order ${orderId} has no commissionable lines`,
    }
  }

  const commissionLines: CalculateCommissionStepData['commission_lines'] = []
  let totalRetailCents = 0
  let totalCommissionCents = 0

  for (const line of rows) {
    if (!COMMISSIONABLE_LINE_STATUSES.has(line.status)) continue

    const commissionCents = Math.round(line.retail_price_cents * effectiveRate)

    commissionLines.push({
      order_line_id: line.id,
      unit_id: line.unit_id,
      serial_number: line.serial_number,
      sku: line.sku,
      product_name: line.product_name,
      retail_price_cents: line.retail_price_cents,
      royalty_cents: line.royalty_cents,
      commission_cents: commissionCents,
    })

    totalRetailCents += line.retail_price_cents
    totalCommissionCents += commissionCents
  }

  if (commissionLines.length === 0) {
    return {
      ok: false,
      kind: 'precondition',
      error: `order ${orderId} has no lines in commissionable statuses`,
    }
  }

  return {
    ok: true,
    data: {
      success: true,
      line_count: commissionLines.length,
      total_retail_cents: totalRetailCents,
      total_commission_cents: totalCommissionCents,
      commission_lines: commissionLines,
    },
  }
}

export async function runInsertCommissionLedgerStep(
  orderId: string,
  consultantId: string,
  consultantName: string,
  commissionTier: string,
  effectiveRate: number,
  commissionInitialStatus: 'earned' | 'held',
  commissionLines: CalculateCommissionStepData['commission_lines'],
): Promise<
  | { ok: true; data: InsertCommissionLedgerStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  if (commissionLines.length === 0) {
    return {
      ok: false,
      kind: 'precondition',
      error: `order ${orderId} has no calculated commission lines to insert`,
    }
  }

  const entries: InsertCommissionLedgerStepData['entries'] = []
  const errors: ValidationError[] = []
  let totalCommissionCents = 0

  for (const line of commissionLines) {
    const { data: rpcData, error: rpcError } = await admin.rpc('create_commission_entry', {
      p_consultant_id: consultantId,
      p_consultant_name: consultantName,
      p_unit_id: line.unit_id,
      p_order_id: orderId,
      p_order_line_id: line.order_line_id,
      p_serial_number: line.serial_number,
      p_sku: line.sku,
      p_product_name: line.product_name,
      p_retail_price_cents: line.retail_price_cents,
      p_commission_tier: commissionTier,
      p_commission_rate: effectiveRate,
      p_commission_cents: line.commission_cents,
      p_status: commissionInitialStatus,
      p_hold_reason: commissionInitialStatus === 'held' ? HOLD_REASON_TAX : null,
    })

    if (rpcError !== null) {
      const raw = rpcError.message ?? 'Unknown DB error'
      const match = raw.match(/\[GTG\][^.]+\./)
      const msg = match ? match[0] : raw

      entries.push({
        order_line_id: line.order_line_id,
        unit_id: line.unit_id,
        serial_number: line.serial_number,
        commission_entry_id: null,
        commission_cents: line.commission_cents,
        status: commissionInitialStatus,
        was_created: false,
        error: msg,
      })
      errors.push({
        code: 'CREATE_COMMISSION_ENTRY_FAILED',
        message: `order_line ${line.order_line_id} failed: ${msg}`,
      })
      continue
    }

    const row = (rpcData as Array<{ commission_entry_id: string; was_created: boolean }> | null)?.[0]
    if (row == null) {
      entries.push({
        order_line_id: line.order_line_id,
        unit_id: line.unit_id,
        serial_number: line.serial_number,
        commission_entry_id: null,
        commission_cents: line.commission_cents,
        status: commissionInitialStatus,
        was_created: false,
        error: 'DB function returned no rows - check server logs.',
      })
      errors.push({
        code: 'CREATE_COMMISSION_ENTRY_MALFORMED',
        message: `order_line ${line.order_line_id} returned no create_commission_entry result row`,
      })
      continue
    }

    totalCommissionCents += line.commission_cents

    entries.push({
      order_line_id: line.order_line_id,
      unit_id: line.unit_id,
      serial_number: line.serial_number,
      commission_entry_id: row.commission_entry_id,
      commission_cents: line.commission_cents,
      status: commissionInitialStatus,
      was_created: row.was_created,
      error: null,
    })
  }

  const created = entries.filter((e) => e.error === null && e.was_created).length
  const alreadyExisted = entries.filter((e) => e.error === null && !e.was_created).length
  const failed = entries.filter((e) => e.error !== null).length

  return {
    ok: true,
    data: {
      success: failed === 0,
      total_lines: entries.length,
      created,
      already_existed: alreadyExisted,
      failed,
      total_commission_cents: totalCommissionCents,
      entries,
      ...(errors.length > 0 ? { errors } : {}),
    },
  }
}
