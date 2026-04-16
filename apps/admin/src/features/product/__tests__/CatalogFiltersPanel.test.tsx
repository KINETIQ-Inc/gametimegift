// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CatalogFiltersPanel } from '../CatalogFiltersPanel'

describe('CatalogFiltersPanel', () => {
  it('emits search/license/refresh interactions', () => {
    const onSearchChange = vi.fn()
    const onLicenseFilterChange = vi.fn()
    const onRefresh = vi.fn()

    render(
      <CatalogFiltersPanel
        search=""
        licenseFilter="ALL"
        loading={false}
        submitting={false}
        onSearchChange={onSearchChange}
        onLicenseFilterChange={onLicenseFilterChange}
        onRefresh={onRefresh}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Search by product name'), {
      target: { value: 'jersey' },
    })
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'CLC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onSearchChange).toHaveBeenCalledWith('jersey')
    expect(onLicenseFilterChange).toHaveBeenCalledWith('CLC')
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
