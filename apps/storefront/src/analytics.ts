export type StorefrontAnalyticsEventName =
  | 'storefront_loaded'
  | 'route_viewed'
  | 'catalog_filter_changed'
  | 'product_selected'
  | 'gift_flow_started'
  | 'cart_item_added'
  | 'checkout_page_viewed'
  | 'checkout_opened'
  | 'checkout_submitted'
  | 'checkout_error'
  | 'checkout_redirected'
  | 'partner_cta_clicked'
  | 'featured_cta_clicked'
  | 'verification_submitted'
  | 'verification_succeeded'
  | 'verification_failed'
  | 'confirmation_viewed'
  | 'confirmation_continue_clicked'
  | 'confirmation_verify_clicked'
  | 'performance_metric_recorded'

export interface StorefrontAnalyticsEvent {
  event: StorefrontAnalyticsEventName
  timestamp: string
  path: string
  sessionId: string
  properties?: Record<string, string | number | boolean | null | undefined>
}

const SESSION_STORAGE_KEY = 'gtg-analytics-session-v1'
const EVENT_BUFFER_KEY = 'gtg-analytics-buffer-v1'
const MAX_BUFFERED_EVENTS = 60

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>
  }
}

function canUseBrowserApis(): boolean {
  return typeof window !== 'undefined'
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `gtg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getSessionId(): string {
  if (!canUseBrowserApis()) {
    return 'server-render'
  }

  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const next = createSessionId()
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, next)
  return next
}

function readBufferedEvents(): StorefrontAnalyticsEvent[] {
  if (!canUseBrowserApis()) {
    return []
  }

  try {
    const raw = window.localStorage.getItem(EVENT_BUFFER_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as StorefrontAnalyticsEvent[] : []
  } catch {
    return []
  }
}

function writeBufferedEvents(events: StorefrontAnalyticsEvent[]): void {
  if (!canUseBrowserApis()) {
    return
  }

  try {
    window.localStorage.setItem(EVENT_BUFFER_KEY, JSON.stringify(events.slice(-MAX_BUFFERED_EVENTS)))
  } catch {
    // Storage quota failures should never block the user flow.
  }
}

function sanitizeProperties(
  properties: StorefrontAnalyticsEvent['properties'],
): StorefrontAnalyticsEvent['properties'] {
  if (!properties) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  )
}

export function trackStorefrontEvent(
  event: StorefrontAnalyticsEventName,
  properties?: StorefrontAnalyticsEvent['properties'],
): StorefrontAnalyticsEvent {
  const payload: StorefrontAnalyticsEvent = {
    event,
    timestamp: new Date().toISOString(),
    path: canUseBrowserApis() ? window.location.pathname + window.location.hash : '/',
    sessionId: getSessionId(),
    properties: sanitizeProperties(properties),
  }

  if (!canUseBrowserApis()) {
    return payload
  }

  writeBufferedEvents([...readBufferedEvents(), payload])

  window.dataLayer = window.dataLayer ?? []
  window.dataLayer.push(payload as unknown as Record<string, unknown>)
  window.dispatchEvent(new CustomEvent('gtg:analytics', { detail: payload }))

  return payload
}

export function initStorefrontPerformanceTracking(): void {
  if (!canUseBrowserApis() || typeof PerformanceObserver === 'undefined') {
    return
  }

  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes ?? []
  const metricMap: Array<{ entryType: string; metricName: string }> = [
    { entryType: 'paint', metricName: 'paint' },
    { entryType: 'largest-contentful-paint', metricName: 'largest-contentful-paint' },
  ]

  for (const metric of metricMap) {
    if (!supportedEntryTypes.includes(metric.entryType)) {
      continue
    }

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'paint' && entry.name !== 'first-contentful-paint') {
            continue
          }

          trackStorefrontEvent('performance_metric_recorded', {
            metric: metric.metricName,
            name: entry.name,
            value: Math.round(entry.startTime),
          })
        }
      })

      observer.observe({ type: metric.entryType, buffered: true })
    } catch {
      // Some browsers expose the entry type but still reject observe().
    }
  }
}

export function getBufferedStorefrontEvents(): StorefrontAnalyticsEvent[] {
  return readBufferedEvents()
}
