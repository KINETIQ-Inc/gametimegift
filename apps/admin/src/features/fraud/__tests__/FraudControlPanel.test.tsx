// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FraudControlPanel } from '../FraudControlPanel'
import { EMPTY_LOCK_UNIT_FORM, EMPTY_UNLOCK_UNIT_FORM } from '../../product/types'

describe('FraudControlPanel', () => {
  it('updates lock and unlock forms and submits both workflows', () => {
    let lockForm = { ...EMPTY_LOCK_UNIT_FORM }
    let unlockForm = { ...EMPTY_UNLOCK_UNIT_FORM }

    const onLockFormChange = vi.fn((next) => {
      lockForm = next
    })
    const onUnlockFormChange = vi.fn((next) => {
      unlockForm = next
    })
    const onLockSubmit = vi.fn((event) => event.preventDefault())
    const onUnlockSubmit = vi.fn((event) => event.preventDefault())

    const { rerender } = render(
      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={null}
        unlockResult={null}
        submitting={false}
        onLockFormChange={onLockFormChange}
        onUnlockFormChange={onUnlockFormChange}
        onLockSubmit={onLockSubmit}
        onUnlockSubmit={onUnlockSubmit}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('UUID of the serialized unit'), {
      target: { value: '123e4567-e89b-42d3-a456-426614174000' },
    })
    rerender(
      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={null}
        unlockResult={null}
        submitting={false}
        onLockFormChange={onLockFormChange}
        onUnlockFormChange={onUnlockFormChange}
        onLockSubmit={onLockSubmit}
        onUnlockSubmit={onUnlockSubmit}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Reason for the lock — required for compliance audit.'), {
      target: { value: 'Chargeback investigation' },
    })
    rerender(
      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={null}
        unlockResult={null}
        submitting={false}
        onLockFormChange={onLockFormChange}
        onUnlockFormChange={onUnlockFormChange}
        onLockSubmit={onLockSubmit}
        onUnlockSubmit={onUnlockSubmit}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('UUID from the lock action result'), {
      target: { value: '0d6ef1a1-1234-4567-89ab-1234567890ab' },
    })
    rerender(
      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={null}
        unlockResult={null}
        submitting={false}
        onLockFormChange={onLockFormChange}
        onUnlockFormChange={onUnlockFormChange}
        onLockSubmit={onLockSubmit}
        onUnlockSubmit={onUnlockSubmit}
      />,
    )

    fireEvent.change(
      screen.getByPlaceholderText(
        'Why is this lock being released? Reference any investigation conclusion.',
      ),
      {
        target: { value: 'False positive confirmed' },
      },
    )

    rerender(
      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={null}
        unlockResult={null}
        submitting={false}
        onLockFormChange={onLockFormChange}
        onUnlockFormChange={onUnlockFormChange}
        onLockSubmit={onLockSubmit}
        onUnlockSubmit={onUnlockSubmit}
      />,
    )

    fireEvent.submit(screen.getByRole('button', { name: 'Lock Unit' }).closest('form')!)
    fireEvent.submit(screen.getByRole('button', { name: 'Unlock Unit' }).closest('form')!)

    expect(onLockFormChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: '123e4567-e89b-42d3-a456-426614174000',
        reason: 'Chargeback investigation',
      }),
    )
    expect(onUnlockFormChange).toHaveBeenCalledWith(
      expect.objectContaining({
        lockRecordId: '0d6ef1a1-1234-4567-89ab-1234567890ab',
        releaseReason: 'False positive confirmed',
      }),
    )
    expect(onLockSubmit).toHaveBeenCalledTimes(1)
    expect(onUnlockSubmit).toHaveBeenCalledTimes(1)
  })
})
