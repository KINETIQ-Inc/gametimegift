export function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function toSlug(value: string): string {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

export function toTitleCase(value: string): string {
  return compactWhitespace(value)
    .toLowerCase()
    .split(' ')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}
