import type {
  ConsultantCommissionEarnedResult,
  ConsultantPendingPayoutsResult,
  ConsultantUnitsSoldResult,
  GetReferralLinkResult,
} from '@gtg/api'
import { calculateCommissionCents } from '../../../packages/domain/src/commission'

export interface ChannelReferralLink {
  channel: string
  label: string
  href: string
}

export interface RevenueOverview {
  grossSalesCents: number
  earnedCents: number
  pendingPayoutCents: number
  unitsSold: number
  conversionLabel: string
}

export function buildChannelReferralLinks(referralUrl: string): ChannelReferralLink[] {
  const channels = [
    { channel: 'text', label: 'Text / SMS' },
    { channel: 'email', label: 'Email' },
    { channel: 'instagram', label: 'Instagram Bio' },
  ] as const

  return channels.map(({ channel, label }) => {
    const url = new URL(referralUrl)
    url.searchParams.set('utm_source', channel)
    url.searchParams.set('utm_medium', 'consultant-share')
    url.searchParams.set('utm_campaign', 'revenue-engine')

    return {
      channel,
      label,
      href: url.toString(),
    }
  })
}

export function getReferralHeadline(result: GetReferralLinkResult | null): string {
  if (!result) {
    return 'Generate your revenue link'
  }

  if ((result.total_referred_orders ?? 0) > 0) {
    return `${result.display_name} has a live sales channel`
  }

  return `${result.display_name} is ready to start earning`
}

export function buildRevenueOverview(
  unitsResult: ConsultantUnitsSoldResult | null,
  commissionResult: ConsultantCommissionEarnedResult | null,
  pendingResult: ConsultantPendingPayoutsResult | null,
): RevenueOverview {
  const grossSalesCents =
    unitsResult?.period_summary.gross_sales_cents ??
    commissionResult?.lifetime.gross_sales_cents ??
    0
  const earnedCents = commissionResult?.period_summary.net_cents ?? 0
  const pendingPayoutCents =
    pendingResult?.pending_payout_cents ??
    unitsResult?.lifetime.pending_payout_cents ??
    commissionResult?.lifetime.pending_payout_cents ??
    0
  const unitsSold = unitsResult?.period_summary.units_sold ?? 0
  const ordersCount = unitsResult?.period_summary.orders_count ?? 0

  return {
    grossSalesCents,
    earnedCents,
    pendingPayoutCents,
    unitsSold,
    conversionLabel:
      ordersCount > 0 ? `${unitsSold} units across ${ordersCount} orders` : 'No closed orders yet',
  }
}

export function estimateCommissionScenario(
  retailPriceCents: number,
  commissionRate: number,
  quantity: number,
): {
  perUnitCommissionCents: number
  projectedCommissionCents: number
} {
  const safeQuantity = Math.max(1, Math.floor(quantity))
  const perUnitCommissionCents = calculateCommissionCents(retailPriceCents, commissionRate)

  return {
    perUnitCommissionCents,
    projectedCommissionCents: perUnitCommissionCents * safeQuantity,
  }
}

export function deriveSuggestedCommissionRate(
  commissionResult: ConsultantCommissionEarnedResult | null,
): number {
  const recentRate = commissionResult?.recent_entries[0]?.commission_rate

  if (typeof recentRate === 'number' && Number.isFinite(recentRate) && recentRate >= 0) {
    return recentRate
  }

  return 0.1
}
