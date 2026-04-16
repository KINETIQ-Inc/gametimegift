import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  deactivateProduct,
  isTransientError,
  toUserMessage,
  type AssignProductLicenseResult,
  type BulkUploadSerializedUnitsResult,
  type CommissionSummaryConsultantResult,
  type LockUnitResult,
  type ProductListItem,
  type RoyaltyReportResult,
  type RoyaltySummaryResult,
  type UnlockUnitResult,
  type ValidateBatchResult,
  type ViewFraudEventsResult,
} from '@gtg/api'
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
  createEditState,
  type BatchValidationFormState,
  type CommissionSummaryFormState,
  type CreateFormState,
  type EditFormState,
  type FraudReportFormState,
  type LicenseAssignFormState,
  type LicenseBody,
  type LockUnitFormState,
  type RoyaltySummaryFormState,
  type UnlockUnitFormState,
  type UploadFormState,
} from '../features/product/types'
import {
  assignProductLicenseFromForm,
  createProductFromForm,
  fetchProducts,
  getCommissionSummaryFromForm,
  getArmyRoyaltyReportFromForm,
  getClcRoyaltyReportFromForm,
  getFraudEventsFromForm,
  getRoyaltySummaryFromForm,
  exportRoyaltyCsvFromForm,
  lockUnitFromForm,
  unlockUnitFromForm,
  updateProductFromForm,
  uploadSerializedUnitsFromForm,
  validateBatchFromForm,
} from '../services/admin-service'

interface ActiveFilters {
  search: string
  licenseBody: 'ALL' | LicenseBody
}

export function useAdminDashboard() {
  const [products, setProducts] = useState<ProductListItem[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [licenseFilter, setLicenseFilter] = useState<'ALL' | LicenseBody>('ALL')
  const [createForm, setCreateForm] = useState<CreateFormState>(EMPTY_CREATE_FORM)
  const [editForm, setEditForm] = useState<EditFormState | null>(null)
  const [uploadForm, setUploadForm] = useState<UploadFormState>(EMPTY_UPLOAD_FORM)
  const [licenseAssignForm, setLicenseAssignForm] = useState<LicenseAssignFormState>(
    EMPTY_LICENSE_ASSIGN_FORM,
  )
  const [batchValidationForm, setBatchValidationForm] = useState<BatchValidationFormState>(
    EMPTY_BATCH_VALIDATION_FORM,
  )
  const [royaltySummaryForm, setRoyaltySummaryForm] = useState<RoyaltySummaryFormState>(
    EMPTY_ROYALTY_SUMMARY_FORM,
  )
  const [commissionSummaryForm, setCommissionSummaryForm] = useState<CommissionSummaryFormState>(
    EMPTY_COMMISSION_SUMMARY_FORM,
  )
  const [lockForm, setLockForm] = useState<LockUnitFormState>(EMPTY_LOCK_UNIT_FORM)
  const [unlockForm, setUnlockForm] = useState<UnlockUnitFormState>(EMPTY_UNLOCK_UNIT_FORM)
  const [fraudReportForm, setFraudReportForm] = useState<FraudReportFormState>(EMPTY_FRAUD_REPORT_FORM)

  const [uploadResult, setUploadResult] = useState<BulkUploadSerializedUnitsResult | null>(null)
  const [licenseAssignResult, setLicenseAssignResult] =
    useState<AssignProductLicenseResult | null>(null)
  const [batchValidationResult, setBatchValidationResult] = useState<ValidateBatchResult | null>(null)
  const [royaltySummaryResult, setRoyaltySummaryResult] = useState<RoyaltySummaryResult | null>(null)
  const [clcReportResult, setClcReportResult] = useState<RoyaltyReportResult | null>(null)
  const [armyReportResult, setArmyReportResult] = useState<RoyaltyReportResult | null>(null)
  const [commissionSummaryResult, setCommissionSummaryResult] =
    useState<CommissionSummaryConsultantResult | null>(null)
  const [lockResult, setLockResult] = useState<LockUnitResult | null>(null)
  const [unlockResult, setUnlockResult] = useState<UnlockUnitResult | null>(null)
  const [fraudEventsResult, setFraudEventsResult] = useState<ViewFraudEventsResult | null>(null)

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [reportLoading, setReportLoading] = useState<'CLC' | 'ARMY' | null>(null)
  const [csvLoading, setCsvLoading] = useState<'CLC' | 'ARMY' | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  /**
   * When set, the error banner shows a "Try again" button.
   * Only set for transient failures on background load operations.
   * Wrapped in an object to avoid React treating the function as a state initializer.
   */
  const [retryFn, setRetryFn] = useState<{ fn: () => void } | null>(null)

  const activeFilters = useMemo<ActiveFilters>(
    () => ({
      search: search.trim(),
      licenseBody: licenseFilter,
    }),
    [search, licenseFilter],
  )

  async function loadProducts(): Promise<void> {
    setLoading(true)
    setErrorMessage(null)

    try {
      const result = await fetchProducts({
        search: activeFilters.search,
        licenseBody: activeFilters.licenseBody,
      })

      setProducts(result.products)
      setTotal(result.total)

      setUploadForm((prev) => {
        const firstProduct = result.products[0]
        if (prev.productId || !firstProduct) return prev
        return { ...prev, productId: firstProduct.id }
      })

      setLicenseAssignForm((prev) => {
        const firstProduct = result.products[0]
        if (prev.productId || !firstProduct) return prev
        return {
          ...prev,
          productId: firstProduct.id,
          licenseBody: firstProduct.license_body,
        }
      })
    } catch (error) {
      const msg = toUserMessage(error, 'Failed to load products.')
      setErrorMessage(msg)
      if (isTransientError(error)) {
        setRetryFn({ fn: () => void loadProducts() })
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters.search, activeFilters.licenseBody])

  function clearBanners(): void {
    setErrorMessage(null)
    setSuccessMessage(null)
    setRetryFn(null)
  }

  async function onCreateSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      await createProductFromForm(createForm)
      setSuccessMessage('Product created.')
      setCreateForm(EMPTY_CREATE_FORM)
      await loadProducts()
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Create failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onEditSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!editForm) return

    clearBanners()
    setSubmitting(true)

    try {
      await updateProductFromForm(editForm)
      setSuccessMessage('Product updated.')
      setEditForm(null)
      await loadProducts()
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Update failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onDeactivate(productId: string): Promise<void> {
    clearBanners()
    setSubmitting(true)

    try {
      await deactivateProduct(productId)
      setSuccessMessage('Product deactivated.')
      if (editForm?.productId === productId) {
        setEditForm(null)
      }
      await loadProducts()
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Deactivate failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onAssignLicenseSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await assignProductLicenseFromForm(licenseAssignForm)
      setLicenseAssignResult(result)
      setSuccessMessage(`License updated for ${result.sku}.`)
      await loadProducts()
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'License assignment failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onUploadSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await uploadSerializedUnitsFromForm(uploadForm)
      setUploadResult(result)
      setSuccessMessage(
        `Upload complete. Received ${result.received_count}/${result.submitted_count} units for batch ${result.batch_number}.`,
      )
      setUploadForm((prev) => ({
        ...prev,
        batchNumber: '',
        expectedUnitCount: '',
        purchaseOrderNumber: '',
        notes: '',
        file: null,
      }))
      await loadProducts()
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Upload failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onValidateBatchSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await validateBatchFromForm(batchValidationForm)
      if (!result) {
        setBatchValidationResult(null)
        setErrorMessage('Batch not found.')
        return
      }

      setBatchValidationResult(result)
      setSuccessMessage(
        result.issues.length === 0
          ? `Batch ${result.batch.batch_number} passed validation.`
          : `Batch ${result.batch.batch_number} validated with ${result.issues.length} issue(s).`,
      )
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Batch validation failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onRoyaltySummarySubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await getRoyaltySummaryFromForm(royaltySummaryForm)
      setRoyaltySummaryResult(result)
      setSuccessMessage(
        `Royalty summary loaded for ${result.year_month} (${result.royalties.length} licensor row(s)).`,
      )
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to load royalty summary.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onCommissionSummarySubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await getCommissionSummaryFromForm(commissionSummaryForm)
      setCommissionSummaryResult(result)
      setSuccessMessage(`Commission summary loaded for consultant ${result.display_name}.`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to load commission summary.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onClcReportRequest(): Promise<void> {
    clearBanners()
    setReportLoading('CLC')

    try {
      const result = await getClcRoyaltyReportFromForm(royaltySummaryForm)
      setClcReportResult(result)
      setSuccessMessage(`CLC report loaded for ${royaltySummaryForm.yearMonth.trim()}.`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to load CLC report.'))
    } finally {
      setReportLoading(null)
    }
  }

  async function onArmyReportRequest(): Promise<void> {
    clearBanners()
    setReportLoading('ARMY')

    try {
      const result = await getArmyRoyaltyReportFromForm(royaltySummaryForm)
      setArmyReportResult(result)
      setSuccessMessage(`Army report loaded for ${royaltySummaryForm.yearMonth.trim()}.`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to load Army report.'))
    } finally {
      setReportLoading(null)
    }
  }

  async function onLockSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await lockUnitFromForm(lockForm)
      setLockResult(result)
      setSuccessMessage(`Unit ${result.unit_id} locked. Lock Record ID: ${result.lock_record_id}`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Lock failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onUnlockSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await unlockUnitFromForm(unlockForm)
      setUnlockResult(result)
      setSuccessMessage(
        `Unit ${result.serial_number} unlocked. Restored to: ${result.restored_status}.`,
      )
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Unlock failed.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onFraudReportSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    clearBanners()
    setSubmitting(true)

    try {
      const result = await getFraudEventsFromForm(fraudReportForm)
      setFraudEventsResult(result)
      setSuccessMessage(`Loaded ${result.flags.length} fraud event(s).`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to load fraud events.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onRoyaltyCsvExport(licenseBody: 'CLC' | 'ARMY'): Promise<void> {
    clearBanners()
    setCsvLoading(licenseBody)

    try {
      const result = await exportRoyaltyCsvFromForm(royaltySummaryForm, licenseBody)
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = result.filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(objectUrl)
      setSuccessMessage(`${licenseBody} CSV export downloaded.`)
    } catch (error) {
      setErrorMessage(toUserMessage(error, 'Failed to export royalty CSV.'))
    } finally {
      setCsvLoading(null)
    }
  }

  return {
    products,
    total,
    search,
    licenseFilter,
    createForm,
    editForm,
    uploadForm,
    licenseAssignForm,
    batchValidationForm,
    royaltySummaryForm,
    commissionSummaryForm,
    uploadResult,
    licenseAssignResult,
    batchValidationResult,
    royaltySummaryResult,
    clcReportResult,
    armyReportResult,
    commissionSummaryResult,
    loading,
    submitting,
    reportLoading,
    csvLoading,
    errorMessage,
    successMessage,
    retryFn,
    setSearch,
    setLicenseFilter,
    setCreateForm,
    setEditForm,
    setUploadForm,
    setLicenseAssignForm,
    setBatchValidationForm,
    setRoyaltySummaryForm,
    setCommissionSummaryForm,
    loadProducts,
    onCreateSubmit,
    onEditSubmit,
    onDeactivate,
    onAssignLicenseSubmit,
    onUploadSubmit,
    onValidateBatchSubmit,
    onRoyaltySummarySubmit,
    onClcReportRequest,
    onArmyReportRequest,
    onRoyaltyCsvExport,
    onCommissionSummarySubmit,
    lockForm,
    unlockForm,
    fraudReportForm,
    lockResult,
    unlockResult,
    fraudEventsResult,
    setLockForm,
    setUnlockForm,
    setFraudReportForm,
    onLockSubmit,
    onUnlockSubmit,
    onFraudReportSubmit,
    createEditState,
  }
}
