// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProductsTablePanel } from '../ProductsTablePanel'

describe('ProductsTablePanel', () => {
  it('emits edit and deactivate actions', () => {
    const onEdit = vi.fn()
    const onDeactivate = vi.fn()

    render(
      <ProductsTablePanel
        products={[
          {
            id: 'p1',
            sku: 'APP-1',
            name: 'Product 1',
            description: null,
            school: 'University of Florida',
            license_body: 'CLC',
            retail_price_cents: 4999,
            available_count: 8,
            in_stock: true,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]}
        loading={false}
        submitting={false}
        total={1}
        onEdit={onEdit}
        onDeactivate={onDeactivate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onDeactivate).toHaveBeenCalledWith('p1')
  })
})
