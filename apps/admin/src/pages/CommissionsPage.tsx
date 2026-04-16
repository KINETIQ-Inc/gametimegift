/**
 * CommissionsPage — "/commissions"
 *
 * Commission summary lookup by consultant ID and date range.
 */

import { CommissionSummaryPanel } from '../features/product/CommissionSummaryPanel'
import { useAdminState } from '../AdminShell'

export function CommissionsPage() {
  const {
    commissionSummaryForm,
    commissionSummaryResult,
    submitting,
    setCommissionSummaryForm,
    onCommissionSummarySubmit,
  } = useAdminState()

  return (
    <>
      <section className="hero">
        <h1 className="admin-page-title">Commissions</h1>
        <p className="admin-page-sub">Look up commission summaries by consultant ID and date range.</p>
      </section>

      <CommissionSummaryPanel
        form={commissionSummaryForm}
        result={commissionSummaryResult}
        submitting={submitting}
        onFormChange={setCommissionSummaryForm}
        onSubmit={(e) => void onCommissionSummarySubmit(e)}
      />
    </>
  )
}
