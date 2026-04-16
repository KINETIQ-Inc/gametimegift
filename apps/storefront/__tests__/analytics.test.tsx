// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getBufferedStorefrontEvents,
  initStorefrontPerformanceTracking,
  trackStorefrontEvent,
} from '../src/analytics'

describe('storefront analytics', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.dataLayer = []
  })

  it('buffers and publishes tracked events', () => {
    const listener = vi.fn()
    window.addEventListener('gtg:analytics', listener as EventListener)

    const event = trackStorefrontEvent('checkout_opened', {
      sku: 'GTG-001',
      priceCents: 12900,
    })

    expect(event.event).toBe('checkout_opened')
    expect(window.dataLayer).toHaveLength(1)
    expect(getBufferedStorefrontEvents()).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)

    window.removeEventListener('gtg:analytics', listener as EventListener)
  })

  it('does not throw when performance observers are unavailable', () => {
    const originalObserver = globalThis.PerformanceObserver
    // @ts-expect-error test override
    globalThis.PerformanceObserver = undefined

    expect(() => initStorefrontPerformanceTracking()).not.toThrow()

    globalThis.PerformanceObserver = originalObserver
  })
})
