// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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

// AuthProvider (wraps the whole App, outside AdminShell) calls getAuthSession()
// on mount, which needs a real configureSupabase() call production only makes
// in main.tsx. Mocked here for the same reason use-admin-dashboard is mocked
// below — this test isolates the admin shell's rendering, not real auth.
vi.mock('@gtg/api', async () => {
  const actual = await vi.importActual<typeof import('@gtg/api')>('@gtg/api')
  return {
    ...actual,
    getAuthSession: vi.fn().mockResolvedValue(
      { role: 'admin', userId: 'test-admin', email: 'admin@test.gtg' },
    ),
    subscribeToAuthChanges: vi.fn(() => () => {}),
  }
})

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
  it('mounts the fraud control and reporting panels in the admin shell', async () => {
    // Production renders <App /> inside <BrowserRouter> (see main.tsx) —
    // App itself has no Router of its own, so the test must supply one too.
    // /fraud is the protected route that renders the panels this test checks for.
    render(
      <MemoryRouter initialEntries={['/fraud']}>
        <App />
      </MemoryRouter>,
    )

    // AdminShell shows a "Checking session…" loading state until the mocked
    // getAuthSession() promise resolves — wait for the real content past it.
    expect(await screen.findByRole('heading', { name: 'Lock and unlock serialized units.' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Review flagged units.' })).toBeTruthy()
  })
})
