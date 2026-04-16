import type { CommissionStatus } from '@gtg/types'
import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { getTableClient, invokeFunction } from './transport'
import type { Database } from './transport'

type ConsultantProfileRow = Database['public']['Tables']['consultant_profiles']['Row']
type OrderRow = Database['public']['Tables']['orders']['Row']
type CommissionEntryRow = Database['public']['Tables']['commission_entries']['Row']

const COMMISSION_STATUSES: CommissionStatus[] = [
  'earned',
  'held',
  'approved',
  'paid',
  'reversed',
  'voided',
]

const DEFAULT_RECENT_ORDERS_LIMIT = 10
const DEFAULT_RECENT_COMMISSIONS_LIMIT = 10
const MAX_RECENT_LIMIT = 100

function assertConsultantId(consultantId: string, fnName: string): void {
  assertUuidV4(consultantId, 'consultantId', fnName)
}

function normalizeLimit(limit: number | undefined, fallback: number, field: string): number {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECENT_LIMIT) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): ${field} must be an integer between 1 and ${MAX_RECENT_LIMIT}.`,
      'VALIDATION_ERROR',
    )
  }
  return limit
}

// ─── Consultant Dashboard ─────────────────────────────────────────────────────

export interface GetConsultantDashboardInput {
  consultantId: string
  recentOrdersLimit?: number
  recentCommissionsLimit?: number
}

export interface ConsultantStatusAggregate {
  count: number
  commissionCents: number
}

export interface GetConsultantDashboardResult {
  profile: ConsultantProfileRow
  orderSummary: {
    totalOrders: number
    totalSalesCents: number
  }
  commissionSummary: {
    totalEntries: number
    totalCommissionCents: number
    byStatus: Record<CommissionStatus, ConsultantStatusAggregate>
  }
  recentOrders: OrderRow[]
  recentCommissions: CommissionEntryRow[]
}

/**
 * Fetch consultant-facing dashboard data.
 *
 * Returns null when the consultant profile does not exist or is not visible
 * to the current authenticated user under RLS.
 */
export async function getConsultantDashboard(
  input: GetConsultantDashboardInput,
): Promise<GetConsultantDashboardResult | null> {
  const { consultantId } = input
  const recentOrdersLimit = normalizeLimit(
    input.recentOrdersLimit,
    DEFAULT_RECENT_ORDERS_LIMIT,
    'recentOrdersLimit',
  )
  const recentCommissionsLimit = normalizeLimit(
    input.recentCommissionsLimit,
    DEFAULT_RECENT_COMMISSIONS_LIMIT,
    'recentCommissionsLimit',
  )

  if (!consultantId || typeof consultantId !== 'string') {
    throw new ApiRequestError(
      '[GTG] getConsultantDashboard(): consultantId is required.',
      'VALIDATION_ERROR',
    )
  }
  assertConsultantId(consultantId, 'getConsultantDashboard')

  const client = getTableClient()

  const { data: profileData, error: profileError } = await client
    .from('consultant_profiles')
    .select('*')
    .eq('id', consultantId)
    .maybeSingle()

  if (profileError) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): consultant profile query failed: ${profileError.message}`,
      'QUERY_ERROR',
    )
  }

  const profile = (profileData ?? null) as ConsultantProfileRow | null
  if (!profile) return null

  const { data: allOrdersData, error: ordersError } = await client
    .from('orders')
    .select('*')
    .eq('consultant_id', consultantId)

  if (ordersError) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): orders query failed: ${ordersError.message}`,
      'QUERY_ERROR',
    )
  }

  const { data: recentOrdersData, error: recentOrdersError } = await client
    .from('orders')
    .select('*')
    .eq('consultant_id', consultantId)
    .order('created_at', { ascending: false })
    .limit(recentOrdersLimit)

  if (recentOrdersError) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): recent orders query failed: ${recentOrdersError.message}`,
      'QUERY_ERROR',
    )
  }

  const { data: allCommissionsData, error: commissionsError } = await client
    .from('commission_entries')
    .select('*')
    .eq('consultant_id', consultantId)

  if (commissionsError) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): commission entries query failed: ${commissionsError.message}`,
      'QUERY_ERROR',
    )
  }

  const { data: recentCommissionsData, error: recentCommissionsError } = await client
    .from('commission_entries')
    .select('*')
    .eq('consultant_id', consultantId)
    .order('created_at', { ascending: false })
    .limit(recentCommissionsLimit)

  if (recentCommissionsError) {
    throw new ApiRequestError(
      `[GTG] getConsultantDashboard(): recent commissions query failed: ${recentCommissionsError.message}`,
      'QUERY_ERROR',
    )
  }

  const orderRows = (allOrdersData ?? []) as OrderRow[]
  const commissionRows = (allCommissionsData ?? []) as CommissionEntryRow[]

  const totalSalesCents = orderRows.reduce((sum, order) => sum + order.total_cents, 0)
  const totalCommissionCents = commissionRows.reduce(
    (sum, entry) => sum + entry.commission_cents,
    0,
  )

  const byStatus = Object.fromEntries(
    COMMISSION_STATUSES.map((status) => [status, { count: 0, commissionCents: 0 }]),
  ) as Record<CommissionStatus, ConsultantStatusAggregate>

  for (const entry of commissionRows) {
    const statusSummary = byStatus[entry.status]
    statusSummary.count += 1
    statusSummary.commissionCents += entry.commission_cents
  }

  return {
    profile,
    orderSummary: {
      totalOrders: orderRows.length,
      totalSalesCents,
    },
    commissionSummary: {
      totalEntries: commissionRows.length,
      totalCommissionCents,
      byStatus,
    },
    recentOrders: (recentOrdersData ?? []) as OrderRow[],
    recentCommissions: (recentCommissionsData ?? []) as CommissionEntryRow[],
  }
}

// ─── Commission Summary ───────────────────────────────────────────────────────

export interface CommissionSummaryRecentEntry {
  commission_entry_id: string
  unit_id: string
  serial_number: string
  sku: string
  product_name: string
  retail_price_cents: number
  commission_cents: number
  status: string
  hold_reason: string | null
  created_at: string
}

export interface CommissionSummaryStatusBreakdown {
  count: number
  total_cents: number
}

export interface CommissionSummaryConsultantResult {
  query_mode: 'consultant'
  consultant_id: string
  display_name: string
  commission_tier: string
  date_range: {
    from: string | null
    to: string | null
  }
  profile_totals: {
    lifetime_gross_sales_cents: number
    lifetime_commissions_cents: number
    pending_payout_cents: number
  }
  by_status: Record<CommissionStatus, CommissionSummaryStatusBreakdown>
  recent_entries: CommissionSummaryRecentEntry[]
  recent_entry_count: number
}

export interface GetCommissionSummaryInput {
  consultantId: string
  fromDate?: string
  toDate?: string
}

export async function getCommissionSummary(
  input: GetCommissionSummaryInput,
): Promise<CommissionSummaryConsultantResult> {
  const { consultantId, fromDate, toDate } = input

  if (!consultantId || typeof consultantId !== 'string') {
    throw new ApiRequestError(
      '[GTG] getCommissionSummary(): consultantId is required.',
      'VALIDATION_ERROR',
    )
  }
  assertConsultantId(consultantId, 'getCommissionSummary')

  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new ApiRequestError(
      '[GTG] getCommissionSummary(): fromDate must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }
  if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new ApiRequestError(
      '[GTG] getCommissionSummary(): toDate must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<CommissionSummaryConsultantResult>(
    'commission-summary',
    {
      consultant_id: consultantId,
      ...(fromDate ? { from_date: fromDate } : {}),
      ...(toDate ? { to_date: toDate } : {}),
    },
    'getCommissionSummary',
  )
}

// ─── Units Sold ───────────────────────────────────────────────────────────────

export interface ConsultantUnitsSoldRecentOrder {
  order_id: string
  order_number: string
  status: string
  paid_at: string | null
  product_name: string | null
  serial_number: string | null
  sku: string | null
  retail_price_cents: number | null
  commission_cents: number | null
}

export interface ConsultantUnitsSoldResult {
  consultant_id: string
  display_name: string
  period: { start: string; end: string }
  period_summary: {
    orders_count: number
    units_sold: number
    gross_sales_cents: number
    commission_cents: number
  }
  lifetime: {
    gross_sales_cents: number
    commissions_cents: number
    pending_payout_cents: number
  }
  recent_orders: ConsultantUnitsSoldRecentOrder[]
}

export interface GetConsultantUnitsSoldInput {
  consultantId?: string
  periodStart?: string
  periodEnd?: string
}

export async function getConsultantUnitsSold(
  input: GetConsultantUnitsSoldInput = {},
): Promise<ConsultantUnitsSoldResult> {
  const { consultantId, periodStart, periodEnd } = input

  if (consultantId !== undefined) {
    if (typeof consultantId !== 'string' || consultantId.trim() === '') {
      throw new ApiRequestError(
        '[GTG] getConsultantUnitsSold(): consultantId must be a non-empty string when provided.',
        'VALIDATION_ERROR',
      )
    }
    assertConsultantId(consultantId.trim(), 'getConsultantUnitsSold')
  }
  if (periodStart && !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    throw new ApiRequestError(
      '[GTG] getConsultantUnitsSold(): periodStart must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }
  if (periodEnd && !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new ApiRequestError(
      '[GTG] getConsultantUnitsSold(): periodEnd must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }

  const body: Record<string, string> = {}
  if (consultantId) body.consultant_id = consultantId.trim()
  if (periodStart) body.period_start = periodStart
  if (periodEnd) body.period_end = periodEnd

  return invokeFunction<ConsultantUnitsSoldResult>('get-consultant-units-sold', body, 'getConsultantUnitsSold')
}

// ─── Commission Earned ────────────────────────────────────────────────────────

export interface ConsultantCommissionEarnedRecentEntry {
  entry_id: string
  order_id: string
  order_number: string
  serial_number: string
  sku: string
  product_name: string
  retail_price_cents: number
  commission_tier: string
  commission_rate: number
  commission_cents: number
  status: string
  created_at: string
}

export interface ConsultantCommissionEarnedResult {
  consultant_id: string
  display_name: string
  period: { start: string; end: string }
  period_summary: {
    entries_count: number
    earned_cents: number
    paid_cents: number
    voided_cents: number
    net_cents: number
  }
  lifetime: {
    gross_sales_cents: number
    commissions_cents: number
    pending_payout_cents: number
  }
  recent_entries: ConsultantCommissionEarnedRecentEntry[]
}

export interface GetConsultantCommissionEarnedInput {
  consultantId?: string
  periodStart?: string
  periodEnd?: string
}

export async function getConsultantCommissionEarned(
  input: GetConsultantCommissionEarnedInput = {},
): Promise<ConsultantCommissionEarnedResult> {
  const { consultantId, periodStart, periodEnd } = input

  if (consultantId !== undefined) {
    if (typeof consultantId !== 'string' || consultantId.trim() === '') {
      throw new ApiRequestError(
        '[GTG] getConsultantCommissionEarned(): consultantId must be a non-empty string when provided.',
        'VALIDATION_ERROR',
      )
    }
    assertConsultantId(consultantId.trim(), 'getConsultantCommissionEarned')
  }
  if (periodStart && !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    throw new ApiRequestError(
      '[GTG] getConsultantCommissionEarned(): periodStart must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }
  if (periodEnd && !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new ApiRequestError(
      '[GTG] getConsultantCommissionEarned(): periodEnd must be YYYY-MM-DD.',
      'VALIDATION_ERROR',
    )
  }

  const body: Record<string, string> = {}
  if (consultantId) body.consultant_id = consultantId.trim()
  if (periodStart) body.period_start = periodStart
  if (periodEnd) body.period_end = periodEnd

  return invokeFunction<ConsultantCommissionEarnedResult>(
    'get-consultant-commission-earned',
    body,
    'getConsultantCommissionEarned',
  )
}

// ─── Pending Payouts ──────────────────────────────────────────────────────────

export interface ConsultantPendingPayoutEntry {
  entry_id: string
  order_id: string
  order_number: string
  serial_number: string
  sku: string
  product_name: string
  retail_price_cents: number
  commission_tier: string
  commission_rate: number
  commission_cents: number
  earned_at: string
}

export interface ConsultantPendingPayoutsResult {
  consultant_id: string
  display_name: string
  pending_payout_cents: number
  entries_count: number
  entries: ConsultantPendingPayoutEntry[]
}

export interface GetConsultantPendingPayoutsInput {
  consultantId?: string
}

export async function getConsultantPendingPayouts(
  input: GetConsultantPendingPayoutsInput = {},
): Promise<ConsultantPendingPayoutsResult> {
  const { consultantId } = input

  if (consultantId !== undefined) {
    if (typeof consultantId !== 'string' || consultantId.trim() === '') {
      throw new ApiRequestError(
        '[GTG] getConsultantPendingPayouts(): consultantId must be a non-empty string when provided.',
        'VALIDATION_ERROR',
      )
    }
    assertConsultantId(consultantId.trim(), 'getConsultantPendingPayouts')
  }

  return invokeFunction<ConsultantPendingPayoutsResult>(
    'get-consultant-pending-payouts',
    consultantId ? { consultant_id: consultantId.trim() } : {},
    'getConsultantPendingPayouts',
  )
}

// ─── Consultant Performance ───────────────────────────────────────────────────

export interface ViewConsultantPerformanceInput {
  consultantId: string
  yearMonth?: string
}

export interface ViewConsultantPerformanceSummary {
  year_month: string | null
  total_entries: number
  earned_count: number
  earned_cents: number
  held_count: number
  held_cents: number
  approved_count: number
  approved_cents: number
  paid_count: number
  paid_cents: number
  reversed_count: number
  reversed_cents: number
  voided_count: number
  voided_cents: number
  net_earned_cents: number
}

export interface ViewConsultantPerformanceResult {
  consultant: Record<string, unknown>
  summary: ViewConsultantPerformanceSummary
  commissions: Array<Record<string, unknown>>
}

export async function viewConsultantPerformance(
  input: ViewConsultantPerformanceInput,
): Promise<ViewConsultantPerformanceResult> {
  const { consultantId, yearMonth } = input

  if (!consultantId || typeof consultantId !== 'string') {
    throw new ApiRequestError(
      '[GTG] viewConsultantPerformance(): consultantId is required.',
      'VALIDATION_ERROR',
    )
  }
  assertConsultantId(consultantId, 'viewConsultantPerformance')

  if (yearMonth !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new ApiRequestError(
      '[GTG] viewConsultantPerformance(): yearMonth must be in YYYY-MM format.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ViewConsultantPerformanceResult>(
    'view-consultant-performance',
    {
      consultant_id: consultantId,
      ...(yearMonth ? { year_month: yearMonth } : {}),
    },
    'viewConsultantPerformance',
  )
}
