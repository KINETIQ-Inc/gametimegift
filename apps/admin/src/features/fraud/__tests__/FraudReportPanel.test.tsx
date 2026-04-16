// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FraudReportPanel } from '../FraudReportPanel'
import { EMPTY_FRAUD_REPORT_FORM } from '../../product/types'

describe('FraudReportPanel', () => {
  it('updates filters, submits the query, and renders empty results', () => {
    let form = { ...EMPTY_FRAUD_REPORT_FORM }
    const onFormChange = vi.fn((next) => {
      form = next
    })
    const onSubmit = vi.fn((event) => event.preventDefault())

    const { rerender } = render(
      <FraudReportPanel
        form={form}
        result={null}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'open' },
    })
    rerender(
      <FraudReportPanel
        form={form}
        result={null}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByLabelText('Severity'), {
      target: { value: 'high' },
    })
    rerender(
      <FraudReportPanel
        form={form}
        result={null}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByLabelText('Limit'), {
      target: { value: '10' },
    })

    rerender(
      <FraudReportPanel
        form={form}
        result={{ flags: [], total: 0, limit: 10, offset: 0 }}
        submitting={false}
        onFormChange={onFormChange}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.submit(screen.getByRole('button', { name: 'Load Events' }).closest('form') as HTMLFormElement)

    expect(onFormChange).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'open',
        severity: 'high',
        limit: '10',
      }),
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No fraud flags match the selected filters.')).toBeTruthy()
  })
})
