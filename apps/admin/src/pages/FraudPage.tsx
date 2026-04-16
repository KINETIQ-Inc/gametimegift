/**
 * FraudPage — "/fraud"
 *
 * Unit lock/unlock controls and fraud event reporting.
 */

import { FraudControlPanel } from '../features/fraud/FraudControlPanel'
import { FraudReportPanel } from '../features/fraud/FraudReportPanel'
import { useAdminState } from '../AdminShell'

export function FraudPage() {
  const {
    lockForm,
    unlockForm,
    fraudReportForm,
    lockResult,
    unlockResult,
    fraudEventsResult,
    submitting,
    setLockForm,
    setUnlockForm,
    setFraudReportForm,
    onLockSubmit,
    onUnlockSubmit,
    onFraudReportSubmit,
  } = useAdminState()

  return (
    <>
      <section className="hero">
        <h1 className="admin-page-title">Fraud Management</h1>
        <p className="admin-page-sub">Lock and unlock serialized units, and review fraud event reports.</p>
      </section>

      <FraudControlPanel
        lockForm={lockForm}
        unlockForm={unlockForm}
        lockResult={lockResult}
        unlockResult={unlockResult}
        submitting={submitting}
        onLockFormChange={setLockForm}
        onUnlockFormChange={setUnlockForm}
        onLockSubmit={(e) => void onLockSubmit(e)}
        onUnlockSubmit={(e) => void onUnlockSubmit(e)}
      />

      <FraudReportPanel
        form={fraudReportForm}
        result={fraudEventsResult}
        submitting={submitting}
        onFormChange={setFraudReportForm}
        onSubmit={(e) => void onFraudReportSubmit(e)}
      />
    </>
  )
}
