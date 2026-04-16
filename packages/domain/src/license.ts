import type { LicenseBody } from '@gtg/types'

const VALID_LICENSE_BODIES: readonly LicenseBody[] = ['CLC', 'ARMY', 'NONE']
const VALID_REPORTING_PERIODS = ['monthly', 'quarterly', 'annual'] as const

export type ReportingPeriod = (typeof VALID_REPORTING_PERIODS)[number]

export function isLicenseBody(value: string): value is LicenseBody {
  return VALID_LICENSE_BODIES.includes(value as LicenseBody)
}

export function assertLicenseBody(value: string, context = 'licenseBody'): asserts value is LicenseBody {
  if (!isLicenseBody(value)) {
    throw new Error(`[GTG] ${context} must be one of: ${VALID_LICENSE_BODIES.join(', ')}.`)
  }
}

export function isReportingPeriod(value: string): value is ReportingPeriod {
  return VALID_REPORTING_PERIODS.includes(value as ReportingPeriod)
}

export function assertReportingPeriod(
  value: string,
  context = 'reportingPeriod',
): asserts value is ReportingPeriod {
  if (!isReportingPeriod(value)) {
    throw new Error(
      `[GTG] ${context} must be one of: ${VALID_REPORTING_PERIODS.join(', ')}.`,
    )
  }
}

export function calculateRoyaltyCents(retailPriceCents: number, royaltyRate: number): number {
  if (!Number.isInteger(retailPriceCents) || retailPriceCents < 0) {
    throw new Error('[GTG] retailPriceCents must be a non-negative integer.')
  }
  if (!Number.isFinite(royaltyRate) || royaltyRate < 0 || royaltyRate > 1) {
    throw new Error('[GTG] royaltyRate must be a decimal between 0 and 1.')
  }
  return Math.round(retailPriceCents * royaltyRate)
}
