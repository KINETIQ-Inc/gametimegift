// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateProductPanel } from '../CreateProductPanel'
import { EMPTY_CREATE_FORM } from '../types'

describe('CreateProductPanel', () => {
  it('updates form and submits create workflow', () => {
    let form = { ...EMPTY_CREATE_FORM }
    const onFormChange = vi.fn((next) => {
      form = next
    })
    const onSubmit = vi.fn((event) => event.preventDefault())

    const { rerender } = render(
      <CreateProductPanel
        form={form}
        submitting={false}
        onSubmit={onSubmit}
        onFormChange={onFormChange}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('APP-NIKE-JERSEY-M'), {
      target: { value: 'APP-TEST-1' },
    })
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Test Product' },
    })
    fireEvent.change(screen.getByLabelText('Cost (cents)'), {
      target: { value: '1000' },
    })
    fireEvent.change(screen.getByLabelText('Retail Price (cents)'), {
      target: { value: '2500' },
    })
    rerender(
      <CreateProductPanel
        form={form}
        submitting={false}
        onSubmit={onSubmit}
        onFormChange={onFormChange}
      />,
    )

    const submitButton = screen.getByRole('button', { name: 'Create Product' })
    fireEvent.submit(submitButton.closest('form') as HTMLFormElement)

    expect(onFormChange).toHaveBeenCalledWith(
      expect.objectContaining({ sku: 'APP-TEST-1' }),
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
