// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MegaNav } from '../src/components/mega-nav/MegaNav'

function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    matches,
    media: '(max-width: 760px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    dispatchEvent: (_event: Event) => true,
    addListener: (_listener: (event: MediaQueryListEvent) => void) => {},
    removeListener: (_listener: (event: MediaQueryListEvent) => void) => {},
  } satisfies MediaQueryList

  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery))
}

describe('MegaNav UI smoke', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    installMatchMedia(false)
  })

  it('opens panel on tab click and closes on escape', () => {
    render(<MegaNav onFilterSelect={() => {}} />)

    const nflTab = screen.getByRole('tab', { name: /NFL/i })
    fireEvent.click(nflTab)

    expect(screen.getByRole('region')).toBeTruthy()
    expect(screen.getByText(/Popular in NFL/i)).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('supports arrow-key tab navigation without activating the filter callback', () => {
    const onFilterSelect = vi.fn()
    render(<MegaNav onFilterSelect={onFilterSelect} />)

    const featuredTab = screen.getByRole('tab', { name: /Featured/i })
    fireEvent.keyDown(featuredTab, { key: 'ArrowRight' })

    expect(onFilterSelect).not.toHaveBeenCalled()
    expect(screen.getByText(/Popular in NFL/i)).toBeTruthy()
  })

  it('closes locked desktop panel on outside pointer down', () => {
    render(<MegaNav onFilterSelect={() => {}} />)

    const nflTab = screen.getByRole('tab', { name: /NFL/i })
    fireEvent.click(nflTab)
    expect(screen.getByRole('region')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('renders mobile accordion sections when matchMedia is mobile', () => {
    installMatchMedia(true)
    render(<MegaNav onFilterSelect={() => {}} />)

    expect(screen.getByRole('button', { name: 'Teams' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Popular in/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Shop by Gift Type' })).toBeTruthy()
  })
})
