// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import {
  EMPTY_BATCH_VALIDATION_FORM,
  EMPTY_COMMISSION_SUMMARY_FORM,
  EMPTY_CREATE_FORM,
  EMPTY_FRAUD_REPORT_FORM,
  EMPTY_LICENSE_ASSIGN_FORM,
  EMPTY_LOCK_UNIT_FORM,
  EMPTY_ROYALTY_SUMMARY_FORM,
  EMPTY_UNLOCK_UNIT_FORM,
  EMPTY_UPLOAD_FORM,
} from '../features/product/types'

vi.mock('../hooks/use-admin-dashboard', () => ({
  useAdminDashboard: () => ({
    products: [],
    total: 0,
    search: '',
    licenseFilter: 'ALL',
    createForm: { ...EMPTY_CREATE_FORM },
    editForm: null,
    uploadForm: { ...EMPTY_UPLOAD_FORM },
    licenseAssignForm: { ...EMPTY_LICENSE_ASSIGN_FORM },
    batchValidationForm: { ...EMPTY_BATCH_VALIDATION_FORM },
    royaltySummaryForm: { ...EMPTY_ROYALTY_SUMMARY_FORM },
    commissionSummaryForm: { ...EMPTY_COMMISSION_SUMMARY_FORM },
    uploadResult: null,
    licenseAssignResult: null,
    batchValidationResult: null,
    royaltySummaryResult: null,
    clcReportResult: null,
    armyReportResult: null,
    commissionSummaryResult: null,
    loading: false,
    submitting: false,
    reportLoading: null,
    csvLoading: null,
    errorMessage: null,
    successMessage: null,
    setSearch: vi.fn(),
    setLicenseFilter: vi.fn(),
    setCreateForm: vi.fn(),
    setEditForm: vi.fn(),
    setUploadForm: vi.fn(),
    setLicenseAssignForm: vi.fn(),
    setBatchValidationForm: vi.fn(),
    setRoyaltySummaryForm: vi.fn(),
    setCommissionSummaryForm: vi.fn(),
    loadProducts: vi.fn(),
    onCreateSubmit: vi.fn(),
    onEditSubmit: vi.fn(),
    onDeactivate: vi.fn(),
    onAssignLicenseSubmit: vi.fn(),
    onUploadSubmit: vi.fn(),
    onValidateBatchSubmit: vi.fn(),
    onRoyaltySummarySubmit: vi.fn(),
    onClcReportRequest: vi.fn(),
    onArmyReportRequest: vi.fn(),
    onRoyaltyCsvExport: vi.fn(),
    onCommissionSummarySubmit: vi.fn(),
    lockForm: { ...EMPTY_LOCK_UNIT_FORM },
    unlockForm: { ...EMPTY_UNLOCK_UNIT_FORM },
    fraudReportForm: { ...EMPTY_FRAUD_REPORT_FORM },
    lockResult: null,
    unlockResult: null,
    fraudEventsResult: null,
    setLockForm: vi.fn(),
    setUnlockForm: vi.fn(),
    setFraudReportForm: vi.fn(),
    onLockSubmit: vi.fn(),
    onUnlockSubmit: vi.fn(),
    onFraudReportSubmit: vi.fn(),
    createEditState: vi.fn(),
  }),
}))

describe('App', () => {
  it('mounts the fraud control and reporting panels in the admin shell', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Lock and unlock serialized units.' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Review flagged units.' })).toBeTruthy()
  })
})
