const DEFAULT_SERIAL_PATTERN = /^[A-Za-z0-9-]{6,100}$/

export function normalizeSerialNumber(serial: string): string {
  return serial.trim().toUpperCase()
}

export function isValidSerialNumber(
  serial: string,
  pattern: RegExp = DEFAULT_SERIAL_PATTERN,
): boolean {
  const normalized = normalizeSerialNumber(serial)
  return pattern.test(normalized)
}

export function assertValidSerialNumber(serial: string, context = 'serialNumber'): string {
  const normalized = normalizeSerialNumber(serial)
  if (!isValidSerialNumber(normalized)) {
    throw new Error(`[GTG] ${context} is invalid.`)
  }
  return normalized
}
