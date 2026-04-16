import { createAdminClient } from '../../_shared/supabase.ts'
import type {
  CalculateRoyaltyStepData,
  FetchLicenseRateStepData,
  InsertRoyaltyLedgerStepData,
  LicenseHolderRateRow,
  ValidationError,
} from '../contracts.ts'

export async function runFetchLicenseRateStep(
  orderId: string,
): Promise<
  | { ok: true; data: FetchLicenseRateStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  const { data: lines, error: linesError } = await admin
    .from('order_lines')
    .select('id, license_body, royalty_rate')
    .eq('order_id', orderId)
    .neq('status', 'cancelled')

  if (linesError) {
    return {
      ok: false,
      kind: 'internal',
      error: `order lines lookup failed: ${linesError.message}`,
    }
  }

  const allLines = lines ?? []
  if (allLines.length === 0) {
    return {
      ok: false,
      kind: 'precondition',
      error: `order ${orderId} has no active lines`,
    }
  }

  const licensedLines = allLines.filter((l) => l.license_body === 'CLC' || l.license_body === 'ARMY')
  if (licensedLines.length === 0) {
    return {
      ok: true,
      data: {
        success: true,
        line_count: allLines.length,
        licensed_line_count: 0,
        license_rates: [],
      },
    }
  }

  const licenseBodies = [...new Set(licensedLines.map((l) => l.license_body))]

  const { data: holders, error: holdersError } = await admin
    .from('license_holders')
    .select(
      'id, license_body, legal_name, code, default_royalty_rate, minimum_royalty_cents, reporting_period, rate_effective_date',
    )
    .in('license_body', licenseBodies)
    .eq('is_active', true)
    .order('rate_effective_date', { ascending: false })

  if (holdersError) {
    return {
      ok: false,
      kind: 'internal',
      error: `license_holders lookup failed: ${holdersError.message}`,
    }
  }

  const activeByBody = new Map<string, LicenseHolderRateRow>()
  for (const holder of ((holders ?? []) as LicenseHolderRateRow[])) {
    if (!activeByBody.has(holder.license_body)) {
      activeByBody.set(holder.license_body, holder)
    }
  }

  const missingBodies = licenseBodies.filter((body) => !activeByBody.has(body))
  if (missingBodies.length > 0) {
    return {
      ok: false,
      kind: 'precondition',
      error: `missing active license_holders for: ${missingBodies.join(', ')}`,
    }
  }

  const licenseRates: FetchLicenseRateStepData['license_rates'] = []

  for (const body of licenseBodies) {
    const holder = activeByBody.get(body)
    if (!holder) continue

    const bodyLines = licensedLines.filter((l) => l.license_body === body)
    const rateMap = new Map<number, number>()

    for (const line of bodyLines) {
      const rate = Number(line.royalty_rate)
      rateMap.set(rate, (rateMap.get(rate) ?? 0) + 1)
    }

    const lineRateGroups = [...rateMap.entries()]
      .map(([royalty_rate, line_count]) => ({ royalty_rate, line_count }))
      .sort((a, b) => b.line_count - a.line_count)

    const defaultRate = Number(holder.default_royalty_rate)
    const hasRateMismatch = lineRateGroups.some((g) => g.royalty_rate !== defaultRate)

    licenseRates.push({
      license_holder_id: holder.id,
      license_body: holder.license_body,
      legal_name: holder.legal_name,
      code: holder.code,
      default_royalty_rate: defaultRate,
      minimum_royalty_cents: holder.minimum_royalty_cents,
      reporting_period: holder.reporting_period,
      line_rate_groups: lineRateGroups,
      has_rate_mismatch: hasRateMismatch,
    })
  }

  return {
    ok: true,
    data: {
      success: true,
      line_count: allLines.length,
      licensed_line_count: licensedLines.length,
      license_rates: licenseRates,
    },
  }
}

export async function runCalculateRoyaltyStep(
  orderId: string,
  licenseRates: FetchLicenseRateStepData['license_rates'],
): Promise<
  | { ok: true; data: CalculateRoyaltyStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  const { data: lines, error: linesError } = await admin
    .from('order_lines')
    .select('license_body, royalty_rate, retail_price_cents')
    .eq('order_id', orderId)
    .neq('status', 'cancelled')

  if (linesError) {
    return {
      ok: false,
      kind: 'internal',
      error: `order lines lookup failed: ${linesError.message}`,
    }
  }

  const licensedLines = (lines ?? []).filter((l) => l.license_body === 'CLC' || l.license_body === 'ARMY')
  if (licensedLines.length === 0) {
    return {
      ok: true,
      data: {
        success: true,
        licensed_line_count: 0,
        total_gross_sales_cents: 0,
        total_royalty_cents: 0,
        by_license_body: [],
      },
    }
  }

  const holderByBody = new Map(
    licenseRates.map((r) => [r.license_body, r]),
  )

  const aggregates = new Map<string, {
    line_count: number
    gross_sales_cents: number
    royalty_cents: number
    rate_count: Map<number, number>
  }>()

  for (const line of licensedLines) {
    const body = line.license_body as string
    const rate = Number(line.royalty_rate)
    const retail = Number(line.retail_price_cents)
    const royalty = Math.round(retail * rate)

    const bucket = aggregates.get(body) ?? {
      line_count: 0,
      gross_sales_cents: 0,
      royalty_cents: 0,
      rate_count: new Map<number, number>(),
    }

    bucket.line_count += 1
    bucket.gross_sales_cents += retail
    bucket.royalty_cents += royalty
    bucket.rate_count.set(rate, (bucket.rate_count.get(rate) ?? 0) + 1)

    aggregates.set(body, bucket)
  }

  const byLicenseBody: CalculateRoyaltyStepData['by_license_body'] = []
  let totalGross = 0
  let totalRoyalty = 0

  for (const [body, bucket] of aggregates.entries()) {
    totalGross += bucket.gross_sales_cents
    totalRoyalty += bucket.royalty_cents

    const rateGroups = [...bucket.rate_count.entries()]
      .map(([royalty_rate, line_count]) => ({ royalty_rate, line_count }))
      .sort((a, b) => b.line_count - a.line_count)

    const storedRate = rateGroups.length === 1
      ? rateGroups[0]!.royalty_rate
      : Math.round((bucket.royalty_cents / Math.max(bucket.gross_sales_cents, 1)) * 10000) / 10000

    const holder = holderByBody.get(body)
    const defaultRate = holder ? Number(holder.default_royalty_rate) : null
    const hasRateMismatch = defaultRate !== null
      ? rateGroups.some((g) => g.royalty_rate !== defaultRate)
      : rateGroups.length > 1

    byLicenseBody.push({
      license_body: body,
      line_count: bucket.line_count,
      gross_sales_cents: bucket.gross_sales_cents,
      royalty_cents: bucket.royalty_cents,
      stored_royalty_rate: storedRate,
      has_rate_mismatch: hasRateMismatch,
    })
  }

  byLicenseBody.sort((a, b) => a.license_body.localeCompare(b.license_body))

  return {
    ok: true,
    data: {
      success: true,
      licensed_line_count: licensedLines.length,
      total_gross_sales_cents: totalGross,
      total_royalty_cents: totalRoyalty,
      by_license_body: byLicenseBody,
    },
  }
}

function computePeriodWindow(reportingPeriod: string, now = new Date()): { period_start: string; period_end: string } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()

  if (reportingPeriod === 'annual') {
    return {
      period_start: `${year}-01-01`,
      period_end: `${year}-12-31`,
    }
  }

  if (reportingPeriod === 'quarterly') {
    const qStartMonth = Math.floor(month / 3) * 3
    const qEndMonth = qStartMonth + 2
    const start = new Date(Date.UTC(year, qStartMonth, 1))
    const end = new Date(Date.UTC(year, qEndMonth + 1, 0))
    return {
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    }
  }

  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0))
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  }
}

export async function runInsertRoyaltyLedgerStep(
  performedBy: string,
  inventoryLedgerEntryIds: string[],
  licenseRates: FetchLicenseRateStepData['license_rates'],
  royaltyByBody: CalculateRoyaltyStepData['by_license_body'],
): Promise<
  | { ok: true; data: InsertRoyaltyLedgerStepData }
  | { ok: false; error: string; kind: 'precondition' | 'internal' }
> {
  const admin = createAdminClient()

  const licensedBodies = royaltyByBody.map((b) => b.license_body)
  if (licensedBodies.length === 0) {
    return {
      ok: true,
      data: {
        success: true,
        created: 0,
        already_existed: 0,
        failed: 0,
        entries: [],
      },
    }
  }

  const holderByBody = new Map(licenseRates.map((r) => [r.license_body, r]))

  const { data: soldRows, error: soldRowsError } = await admin
    .from('inventory_ledger_entries')
    .select('id, license_body')
    .in('id', inventoryLedgerEntryIds)
    .eq('action', 'sold')

  if (soldRowsError) {
    return {
      ok: false,
      kind: 'internal',
      error: `inventory_ledger_entries lookup failed: ${soldRowsError.message}`,
    }
  }

  const ledgerIdsByBody = new Map<string, string[]>()
  for (const row of soldRows ?? []) {
    const body = row.license_body as string
    if (!ledgerIdsByBody.has(body)) ledgerIdsByBody.set(body, [])
    ledgerIdsByBody.get(body)!.push(row.id as string)
  }

  const entries: InsertRoyaltyLedgerStepData['entries'] = []
  const errors: ValidationError[] = []

  for (const bodySummary of royaltyByBody) {
    const holder = holderByBody.get(bodySummary.license_body)
    if (!holder) {
      const message = `missing license holder context for ${bodySummary.license_body}`
      entries.push({
        license_body: bodySummary.license_body,
        royalty_entry_id: null,
        was_created: false,
        units_sold: bodySummary.line_count,
        royalty_cents: bodySummary.royalty_cents,
        remittance_cents: bodySummary.royalty_cents,
        error: message,
      })
      errors.push({ code: 'ROYALTY_HOLDER_MISSING', message })
      continue
    }

    const period = computePeriodWindow(holder.reporting_period)
    const minimum = holder.minimum_royalty_cents ?? 0
    const minimumApplied = minimum > bodySummary.royalty_cents
    const remittanceCents = minimumApplied ? minimum : bodySummary.royalty_cents
    const bodyLedgerIds = ledgerIdsByBody.get(bodySummary.license_body) ?? []

    if (bodyLedgerIds.length === 0) {
      const message = `no sold inventory ledger ids found for ${bodySummary.license_body}`
      entries.push({
        license_body: bodySummary.license_body,
        royalty_entry_id: null,
        was_created: false,
        units_sold: bodySummary.line_count,
        royalty_cents: bodySummary.royalty_cents,
        remittance_cents: remittanceCents,
        error: message,
      })
      errors.push({ code: 'ROYALTY_LEDGER_IDS_MISSING', message })
      continue
    }

    const { data: rpcRows, error: rpcError } = await admin.rpc('create_royalty_entry', {
      p_license_body: bodySummary.license_body,
      p_period_start: period.period_start,
      p_period_end: period.period_end,
      p_license_holder_id: holder.license_holder_id,
      p_license_holder_name: holder.legal_name,
      p_reporting_period: holder.reporting_period,
      p_units_sold: bodySummary.line_count,
      p_gross_sales_cents: bodySummary.gross_sales_cents,
      p_royalty_rate: bodySummary.stored_royalty_rate,
      p_royalty_cents: bodySummary.royalty_cents,
      p_remittance_cents: remittanceCents,
      p_minimum_applied: minimumApplied,
      p_ledger_entry_ids: bodyLedgerIds,
      p_created_by: performedBy,
    })

    if (rpcError !== null) {
      const raw = rpcError.message ?? 'Unknown DB error'
      const gtgMatch = raw.match(/\[GTG\][^.]+\./)
      const message = gtgMatch ? gtgMatch[0] : raw
      entries.push({
        license_body: bodySummary.license_body,
        royalty_entry_id: null,
        was_created: false,
        units_sold: bodySummary.line_count,
        royalty_cents: bodySummary.royalty_cents,
        remittance_cents: remittanceCents,
        error: message,
      })
      errors.push({
        code: 'CREATE_ROYALTY_ENTRY_FAILED',
        message: `${bodySummary.license_body}: ${message}`,
      })
      continue
    }

    const row = (rpcRows as Array<{ royalty_entry_id: string; was_created: boolean }> | null)?.[0]
    if (!row) {
      const message = `${bodySummary.license_body}: create_royalty_entry returned no rows`
      entries.push({
        license_body: bodySummary.license_body,
        royalty_entry_id: null,
        was_created: false,
        units_sold: bodySummary.line_count,
        royalty_cents: bodySummary.royalty_cents,
        remittance_cents: remittanceCents,
        error: message,
      })
      errors.push({ code: 'CREATE_ROYALTY_ENTRY_MALFORMED', message })
      continue
    }

    entries.push({
      license_body: bodySummary.license_body,
      royalty_entry_id: row.royalty_entry_id,
      was_created: row.was_created,
      units_sold: bodySummary.line_count,
      royalty_cents: bodySummary.royalty_cents,
      remittance_cents: remittanceCents,
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
      created,
      already_existed: alreadyExisted,
      failed,
      entries,
      ...(errors.length > 0 ? { errors } : {}),
    },
  }
}
