/**
 * RoyaltiesPage — "/royalties"
 *
 * Royalty summary and licensing body reports (CLC, ARMY).
 */

import { RoyaltySummaryPanel } from '../features/product/RoyaltySummaryPanel'
import { useAdminState } from '../useAdminState'

export function RoyaltiesPage() {
  const {
    royaltySummaryForm,
    royaltySummaryResult,
    clcReportResult,
    armyReportResult,
    submitting,
    reportLoading,
    csvLoading,
    setRoyaltySummaryForm,
    onRoyaltySummarySubmit,
    onClcReportRequest,
    onArmyReportRequest,
    onRoyaltyCsvExport,
  } = useAdminState()

  return (
    <>
      <section className="hero">
        <h1 className="admin-page-title">Royalties</h1>
        <p className="admin-page-sub">Generate royalty summaries and export reports for CLC and ARMY licensing bodies.</p>
      </section>

      <RoyaltySummaryPanel
        form={royaltySummaryForm}
        result={royaltySummaryResult}
        clcReport={clcReportResult}
        armyReport={armyReportResult}
        submitting={submitting}
        reportLoading={reportLoading}
        csvLoading={csvLoading}
        onFormChange={setRoyaltySummaryForm}
        onSubmit={(e) => void onRoyaltySummarySubmit(e)}
        onGenerateClcReport={() => void onClcReportRequest()}
        onGenerateArmyReport={() => void onArmyReportRequest()}
        onExportCsv={(licenseBody) => void onRoyaltyCsvExport(licenseBody)}
      />
    </>
  )
}
