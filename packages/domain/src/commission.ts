import type { CommissionTier } from '@gtg/types'

const TIER_RATE_MAP: Record<Exclude<CommissionTier, 'custom'>, number> = {
  standard: 0.1,
  senior: 0.12,
  elite: 0.15,
}

export function getDefaultCommissionRate(tier: CommissionTier): number | null {
  if (tier === 'custom') return null
  return TIER_RATE_MAP[tier]
}

export function isCommissionRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 1
}

export function assertCommissionRate(rate: number, context = 'commissionRate'): void {
  if (!isCommissionRate(rate)) {
    throw new Error(`[GTG] ${context} must be a decimal between 0 and 1.`)
  }
}

export function calculateCommissionCents(retailPriceCents: number, rate: number): number {
  if (!Number.isInteger(retailPriceCents) || retailPriceCents < 0) {
    throw new Error('[GTG] retailPriceCents must be a non-negative integer.')
  }
  assertCommissionRate(rate)
  return Math.round(retailPriceCents * rate)
}
