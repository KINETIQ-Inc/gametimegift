import { createAdminClient } from '../../_shared/supabase.ts'
import type { InsertInventoryLedgerData, ValidationError } from '../contracts.ts'

export async function runInsertInventoryLedgerStep(
  orderId: string,
  performedBy: string,
): Promise<{ ok: true; data: InsertInventoryLedgerData } | { ok: false; error: string }> {
  const admin = createAdminClient()

  const { data: orderData, error: orderError } = await admin
    .from('orders')
    .select('id, consultant_id')
    .eq('id', orderId)
    .single()

  if (orderError || !orderData) {
    return { ok: false, error: `order lookup failed: ${orderError?.message ?? 'no row returned'}` }
  }

  const consultantId = orderData.consultant_id as string | null

  const { data: lines, error: linesError } = await admin
    .from('order_lines')
    .select('id, unit_id, retail_price_cents')
    .eq('order_id', orderId)
    .neq('status', 'cancelled')

  if (linesError) {
    return { ok: false, error: `order lines lookup failed: ${linesError.message}` }
  }

  const results = lines ?? []
  const ledgerEntryIds: string[] = []
  const errors: ValidationError[] = []

  for (const line of results) {
    const { data, error } = await admin.rpc('sell_unit', {
      p_unit_id: line.unit_id,
      p_order_id: orderId,
      p_performed_by: performedBy,
      p_consultant_id: consultantId,
      p_retail_price_cents: line.retail_price_cents,
    })

    if (error) {
      errors.push({
        code: 'SELL_UNIT_FAILED',
        message:
          `order_line ${line.id} (unit=${line.unit_id}) failed in sell_unit: ${error.message}`,
      })
      continue
    }

    const row = (data as Array<{ ledger_entry_id: string }> | null)?.[0]
    if (!row?.ledger_entry_id) {
      errors.push({
        code: 'LEDGER_INSERT_MALFORMED',
        message:
          `order_line ${line.id} (unit=${line.unit_id}) sell_unit returned no ledger_entry_id.`,
      })
      continue
    }

    ledgerEntryIds.push(row.ledger_entry_id)
  }

  return {
    ok: true,
    data: {
      success: errors.length === 0,
      line_count: results.length,
      inserted_count: ledgerEntryIds.length,
      error_count: errors.length,
      ledger_entry_ids: ledgerEntryIds,
      ...(errors.length > 0 ? { errors } : {}),
    },
  }
}
