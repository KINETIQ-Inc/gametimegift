const USD_CURRENCY = 'USD'
const USD_LOCALE = 'en-US'

export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) throw new Error('[GTG] centsToDollars(): cents must be numeric.')
  return cents / 100
}

export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error('[GTG] dollarsToCents(): dollars must be numeric.')
  return Math.round(dollars * 100)
}

export function formatUsdCents(cents: number, locale = USD_LOCALE): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: USD_CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(centsToDollars(cents))
}
