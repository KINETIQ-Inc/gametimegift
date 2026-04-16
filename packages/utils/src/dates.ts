function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function toIsoDate(value: Date): string {
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`
}

export function monthBounds(yearMonth: string): { start: string; end: string } {
  const match = yearMonth.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
  if (!match) {
    throw new Error('[GTG] monthBounds(): yearMonth must be in YYYY-MM format.')
  }

  const year = Number(match[1])
  const monthZeroIndex = Number(match[2]) - 1
  const startDate = new Date(Date.UTC(year, monthZeroIndex, 1))
  const endDate = new Date(Date.UTC(year, monthZeroIndex + 1, 0))

  return {
    start: toIsoDate(startDate),
    end: toIsoDate(endDate),
  }
}

export function formatDateTime(value: string | Date, locale = 'en-US'): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
}
