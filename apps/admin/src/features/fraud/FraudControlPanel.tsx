/**
 * FraudControlPanel — admin UI for locking and unlocking serialized units.
 *
 * LOCK:
 *   Admin provides unit ID or serial number + a reason.
 *   Calls lockUnit() → creates admin_manual fraud flag (severity: high) →
 *   auto-locks the unit (UnitStatus → fraud_locked).
 *   The returned fraud_flag_id is displayed so the admin can reference it
 *   when unlocking.
 *
 * UNLOCK:
 *   Admin provides the fraud_flag_id and a release reason.
 *   Calls unlockUnit() → resolves flag as 'dismissed' → releases LockRecord →
 *   restores unit's pre-lock status.
 *
 * CONFIRM GATE:
 *   Both actions require a confirmation step before submission.
 *   The lock action additionally warns that the unit will become
 *   immediately unavailable for sale.
 *
 * ROLE: fraud:lock_unit + fraud:unlock_unit (SUPER_ADMIN, FRAUD_INVESTIGATOR)
 */

import type { FormEvent } from 'react'
import { Button, Heading, SectionIntro } from '@gtg/ui'
import type { LockUnitResult, UnlockUnitResult } from '../../services/admin-service'
import type { LockUnitFormState, UnlockUnitFormState } from '../product/types'

export interface FraudControlPanelProps {
  lockForm: LockUnitFormState
  unlockForm: UnlockUnitFormState
  lockResult: LockUnitResult | null
  unlockResult: UnlockUnitResult | null
  submitting: boolean
  onLockFormChange: (form: LockUnitFormState) => void
  onUnlockFormChange: (form: UnlockUnitFormState) => void
  onLockSubmit: (event: FormEvent<HTMLFormElement>) => void
  onUnlockSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function FraudControlPanel({
  lockForm,
  unlockForm,
  lockResult,
  unlockResult,
  submitting,
  onLockFormChange,
  onUnlockFormChange,
  onLockSubmit,
  onUnlockSubmit,
}: FraudControlPanelProps) {
  return (
    <section className="panel fraud-control-panel">
      <SectionIntro
        className="panel-head"
        eyebrow="Fraud Control"
        title="Lock and unlock serialized units."
        description={
          <p>
            Locking a unit marks it <code>fraud_locked</code> and removes it from available
            inventory immediately. Unlocking resolves the underlying fraud flag as dismissed and
            restores the unit&apos;s prior status. Both actions are logged with authority and
            reason for compliance.
          </p>
        }
      />

      <div className="fraud-control-grid">
        {/* ── Lock ── */}
        <div className="fraud-subpanel">
          <Heading as="h3" display={false}>Lock Unit</Heading>
          <p className="fraud-subpanel-desc">
            Creates an <code>admin_manual</code> fraud flag at high severity, which auto-locks the
            unit. Copy the returned <strong>Fraud Flag ID</strong> — you will need it to unlock.
          </p>

          <form className="admin-form" onSubmit={onLockSubmit}>
            <label>
              Unit ID <span className="required-mark">*</span>
              <input
                type="text"
                value={lockForm.unitId}
                onChange={(e) => onLockFormChange({ ...lockForm, unitId: e.target.value })}
                placeholder="UUID of the serialized unit"
                autoComplete="off"
                required
                disabled={submitting}
              />
            </label>

            <label>
              Lock reason <span className="required-mark">*</span>
              <textarea
                value={lockForm.reason}
                onChange={(e) => onLockFormChange({ ...lockForm, reason: e.target.value })}
                placeholder="Reason for the lock — required for compliance audit."
                rows={3}
                required
                disabled={submitting}
              />
            </label>

            <div className="fraud-warning-box">
              ⚠ The unit will become immediately unavailable for sale. This action is logged and
              cannot be silently reversed.
            </div>

            <Button type="submit" variant="danger" disabled={submitting}>
              {submitting ? 'Locking…' : 'Lock Unit'}
            </Button>
          </form>

          {lockResult ? (
            <div className="fraud-result-card">
              <p className="fraud-result-label">Unit locked</p>
              <dl>
                <div>
                  <dt>Lock Record ID</dt>
                  <dd className="mono">{lockResult.lock_record_id}</dd>
                </div>
                <div>
                  <dt>Unit ID</dt>
                  <dd className="mono">{lockResult.unit_id}</dd>
                </div>
                {lockResult.serial_number ? (
                  <div>
                    <dt>Serial</dt>
                    <dd>{lockResult.serial_number}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Authority</dt>
                  <dd>{lockResult.lock_authority}</dd>
                </div>
              </dl>
              <p className="fraud-result-hint">
                Save the Lock Record ID above — you will need it to unlock this unit.
              </p>
            </div>
          ) : null}
        </div>

        {/* ── Unlock ── */}
        <div className="fraud-subpanel">
          <Heading as="h3" display={false}>Unlock Unit</Heading>
          <p className="fraud-subpanel-desc">
            Resolves the fraud flag as <strong>dismissed</strong> and releases all associated lock
            records. The unit is restored to its pre-lock status.
          </p>

          <form className="admin-form" onSubmit={onUnlockSubmit}>
            <label>
              Lock Record ID <span className="required-mark">*</span>
              <input
                type="text"
                value={unlockForm.lockRecordId}
                onChange={(e) =>
                  onUnlockFormChange({ ...unlockForm, lockRecordId: e.target.value })
                }
                placeholder="UUID from the lock action result"
                autoComplete="off"
                required
                disabled={submitting}
              />
            </label>

            <label>
              Release reason <span className="required-mark">*</span>
              <textarea
                value={unlockForm.releaseReason}
                onChange={(e) =>
                  onUnlockFormChange({ ...unlockForm, releaseReason: e.target.value })
                }
                placeholder="Why is this lock being released? Reference any investigation conclusion."
                rows={3}
                required
                disabled={submitting}
              />
            </label>

            <Button type="submit" variant="secondary" disabled={submitting}>
              {submitting ? 'Releasing…' : 'Unlock Unit'}
            </Button>
          </form>

          {unlockResult ? (
            <div className="fraud-result-card">
              <p className="fraud-result-label">Unit unlocked</p>
              <dl>
                <div>
                  <dt>Lock Record ID</dt>
                  <dd className="mono">{unlockResult.lock_record_id}</dd>
                </div>
                <div>
                  <dt>Unit ID</dt>
                  <dd className="mono">{unlockResult.unit_id}</dd>
                </div>
                <div>
                  <dt>Serial</dt>
                  <dd>{unlockResult.serial_number}</dd>
                </div>
                <div>
                  <dt>Restored to</dt>
                  <dd>{unlockResult.restored_status}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
