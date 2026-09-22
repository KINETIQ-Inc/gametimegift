// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditProductPanel } from '../EditProductPanel'
import type { EditFormState } from '../types'

const FORM: EditFormState = {
  productId: '11111111-1111-4111-8111-111111111111',
  name: 'Test product',
  description: '',
  school: '',
  licenseBody: 'NONE',
  category: 'COLLECTIBLE',
  lifecycleStatus: 'ACTIVE',
  size: null,
  color: '',
  styleKey: null,
  royaltyRate: '',
  costCents: '1000',
  retailPriceCents: '2000',
  isActive: true,
}

afterEach(cleanup)

describe('EditProductPanel lifecycle controls', () => {
  it('deactivates a product when its lifecycle becomes ARCHIVED', () => {
    const onFormChange = vi.fn()
    render(
      <EditProductPanel
        form={FORM}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Lifecycle Status'), {
      target: { value: 'ARCHIVED' },
    })

    expect(onFormChange).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleStatus: 'ARCHIVED', isActive: false }),
    )
  })

  it('maps the Active checkbox back to a consistent lifecycle state', () => {
    const onFormChange = vi.fn()
    render(
      <EditProductPanel
        form={FORM}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('Active'))

    expect(onFormChange).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleStatus: 'DISCONTINUED', isActive: false }),
    )
  })
})
