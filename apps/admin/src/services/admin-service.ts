import {
  createProduct,
  listProducts,
  assignProductLicense,
  bulkUploadSerializedUnits,
  exportRoyaltyCsv,
  getArmyRoyaltyReport,
  getClcRoyaltyReport,
  getCommissionSummary,
  getRoyaltySummary,
  lockUnit,
  unlockUnit,
  updateProduct,
  validateBatch,
  viewFraudEvents,
  type AssignProductLicenseResult,
  type BulkUploadSerializedUnitsResult,
  type CommissionSummaryConsultantResult,
  type ExportRoyaltyCsvResult,
  type FraudEventListItem,
  type ListProductsResult,
  type LockUnitResult,
  type RoyaltyReportResult,
  type RoyaltySummaryResult,
  type UnlockUnitResult,
  type ValidateBatchResult,
  type ViewFraudEventsResult,
} from '@gtg/api'
import type {
  BatchValidationFormState,
  CommissionSummaryFormState,
  CreateFormState,
  EditFormState,
  FraudReportFormState,
  LicenseAssignFormState,
  LicenseBody,
  LockUnitFormState,
  RoyaltySummaryFormState,
  UnlockUnitFormState,
  UploadFormState,
} from '../features/product/types'

export type { FraudEventListItem, LockUnitResult, UnlockUnitResult, ViewFraudEventsResult }

export async function fetchProducts(input: {
  search?: string
  licenseBody?: 'ALL' | LicenseBody
}): Promise<ListProductsResult> {
  return listProducts({
    search: input.search || undefined,
    license_body: input.licenseBody && input.licenseBody !== 'ALL' ? input.licenseBody : undefined,
    limit: 200,
    offset: 0,
  })
}

export async function createProductFromForm(form: CreateFormState): Promise<void> {
  await createProduct({
    sku: form.sku.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    school: form.school.trim() || undefined,
    license_body: form.licenseBody,
    royalty_rate: form.royaltyRate.trim() ? Number(form.royaltyRate.trim()) : undefined,
    cost_cents: Number(form.costCents),
    retail_price_cents: Number(form.retailPriceCents),
  })
}

export async function updateProductFromForm(form: EditFormState): Promise<void> {
  await updateProduct({
    product_id: form.productId,
    name: form.name.trim(),
    description: form.description.trim() || null,
    school: form.school.trim() || null,
    license_body: form.licenseBody,
    royalty_rate: form.royaltyRate.trim() ? Number(form.royaltyRate.trim()) : null,
    cost_cents: form.costCents.trim() ? Number(form.costCents) : undefined,
    retail_price_cents: form.retailPriceCents.trim() ? Number(form.retailPriceCents) : undefined,
    active: form.isActive,
  })
}

export async function assignProductLicenseFromForm(
  form: LicenseAssignFormState,
): Promise<AssignProductLicenseResult> {
  return assignProductLicense({
    product_id: form.productId,
    license_body: form.licenseBody,
    royalty_rate: form.royaltyRate.trim() ? Number(form.royaltyRate.trim()) : null,
  })
}

export async function uploadSerializedUnitsFromForm(
  form: UploadFormState,
): Promise<BulkUploadSerializedUnitsResult> {
  if (!form.file) {
    throw new Error('Please attach a CSV file before uploading.')
  }

  return bulkUploadSerializedUnits({
    productId: form.productId,
    batchNumber: form.batchNumber.trim(),
    expectedUnitCount: Number(form.expectedUnitCount),
    purchaseOrderNumber: form.purchaseOrderNumber.trim() || undefined,
    notes: form.notes.trim() || undefined,
    csvFile: form.file,
  })
}

export async function validateBatchFromForm(
  form: BatchValidationFormState,
): Promise<ValidateBatchResult | null> {
  return validateBatch({
    batchNumber: form.batchNumber.trim(),
  })
}

export async function getRoyaltySummaryFromForm(
  form: RoyaltySummaryFormState,
): Promise<RoyaltySummaryResult> {
  return getRoyaltySummary(form.yearMonth.trim())
}

export async function getClcRoyaltyReportFromForm(
  form: RoyaltySummaryFormState,
): Promise<RoyaltyReportResult> {
  return getClcRoyaltyReport(form.yearMonth.trim())
}

export async function getArmyRoyaltyReportFromForm(
  form: RoyaltySummaryFormState,
): Promise<RoyaltyReportResult> {
  return getArmyRoyaltyReport(form.yearMonth.trim())
}

export async function exportRoyaltyCsvFromForm(
  form: RoyaltySummaryFormState,
  licenseBody: 'CLC' | 'ARMY',
): Promise<ExportRoyaltyCsvResult> {
  return exportRoyaltyCsv({
    licenseBody,
    yearMonth: form.yearMonth.trim(),
  })
}

export async function getCommissionSummaryFromForm(
  form: CommissionSummaryFormState,
): Promise<CommissionSummaryConsultantResult> {
  return getCommissionSummary({
    consultantId: form.consultantId.trim(),
    fromDate: form.fromDate || undefined,
    toDate: form.toDate || undefined,
  })
}

export async function lockUnitFromForm(form: LockUnitFormState): Promise<LockUnitResult> {
  if (!form.unitId.trim()) {
    throw new Error('Unit ID is required.')
  }
  return lockUnit({
    unitId: form.unitId.trim(),
    reason: form.reason.trim(),
  })
}

export async function unlockUnitFromForm(form: UnlockUnitFormState): Promise<UnlockUnitResult> {
  return unlockUnit({
    lockRecordId: form.lockRecordId.trim(),
    releaseReason: form.releaseReason.trim(),
  })
}

export async function getFraudEventsFromForm(
  form: FraudReportFormState,
): Promise<ViewFraudEventsResult> {
  return viewFraudEvents({
    status: form.status || undefined,
    severity: form.severity || undefined,
    limit: form.limit ? Number(form.limit) : 50,
    offset: 0,
  } as Parameters<typeof viewFraudEvents>[0])
}
