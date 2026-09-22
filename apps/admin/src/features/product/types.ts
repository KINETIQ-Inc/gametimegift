import type { ProductListItem } from '@gtg/api'

export type LicenseBody = 'CLC' | 'ARMY' | 'NONE'
export type ProductCategory = 'COLLECTIBLE' | 'APPAREL'
export type ApparelSize = 'S' | 'M' | 'L' | 'XL' | 'XXL'
export type GarmentType = 'HOODIE' | 'TEE' | 'LS_TEE' | 'CREWNECK'
export type ProductLifecycleStatus = 'DRAFT' | 'READY_FOR_REVIEW' | 'ACTIVE' | 'DISCONTINUED' | 'ARCHIVED'

export type CreateFormState = {
  sku: string
  name: string
  description: string
  school: string
  licenseBody: LicenseBody
  category: ProductCategory
  // Apparel-only. Ignored (and cleared) when category is COLLECTIBLE.
  garmentType: GarmentType | ''
  size: ApparelSize | ''
  color: string
  royaltyRate: string
  costCents: string
  retailPriceCents: string
}

export type EditFormState = {
  productId: string
  name: string
  description: string
  school: string
  licenseBody: LicenseBody
  category: ProductCategory
  color: string
  lifecycleStatus: ProductLifecycleStatus
  // Read-only — size and style_key are immutable after creation
  // (docs/adr/0001-style-key-immutability.md). Displayed for reference only.
  size: ApparelSize | null
  styleKey: string | null
  royaltyRate: string
  costCents: string
  retailPriceCents: string
  isActive: boolean
}

export type UploadFormState = {
  productId: string
  batchNumber: string
  expectedUnitCount: string
  purchaseOrderNumber: string
  notes: string
  file: File | null
}

export type LicenseAssignFormState = {
  productId: string
  licenseBody: LicenseBody
  royaltyRate: string
}

export type BatchValidationFormState = {
  batchNumber: string
}

export type RoyaltySummaryFormState = {
  yearMonth: string
}

export type CommissionSummaryFormState = {
  consultantId: string
  fromDate: string
  toDate: string
}

export const EMPTY_CREATE_FORM: CreateFormState = {
  sku: '',
  name: '',
  description: '',
  school: '',
  licenseBody: 'CLC',
  category: 'COLLECTIBLE',
  garmentType: '',
  size: '',
  color: '',
  royaltyRate: '',
  costCents: '',
  retailPriceCents: '',
}

export const PRODUCT_CATEGORY_OPTIONS: ProductCategory[] = ['COLLECTIBLE', 'APPAREL']
export const GARMENT_TYPE_OPTIONS: GarmentType[] = ['HOODIE', 'TEE', 'LS_TEE', 'CREWNECK']
// Smallest to largest — matches @gtg/domain's APPAREL_SIZE_ORDER.
export const APPAREL_SIZE_OPTIONS: ApparelSize[] = ['S', 'M', 'L', 'XL', 'XXL']
export const PRODUCT_LIFECYCLE_STATUS_OPTIONS: ProductLifecycleStatus[] = [
  'DRAFT', 'READY_FOR_REVIEW', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED',
]

export const EMPTY_UPLOAD_FORM: UploadFormState = {
  productId: '',
  batchNumber: '',
  expectedUnitCount: '',
  purchaseOrderNumber: '',
  notes: '',
  file: null,
}

export const EMPTY_LICENSE_ASSIGN_FORM: LicenseAssignFormState = {
  productId: '',
  licenseBody: 'CLC',
  royaltyRate: '',
}

export const EMPTY_BATCH_VALIDATION_FORM: BatchValidationFormState = {
  batchNumber: '',
}

export const EMPTY_ROYALTY_SUMMARY_FORM: RoyaltySummaryFormState = {
  yearMonth: new Date().toISOString().slice(0, 7),
}

export const EMPTY_COMMISSION_SUMMARY_FORM: CommissionSummaryFormState = {
  consultantId: '',
  fromDate: '',
  toDate: '',
}

// ─── Fraud Control Form Types ─────────────────────────────────────────────────

export type LockUnitFormState = {
  /** UUID of the serialized unit to lock. */
  unitId: string
  reason: string
}

export type UnlockUnitFormState = {
  /** lock_record_id returned by the lock action. */
  lockRecordId: string
  releaseReason: string
}

export type FraudReportFormState = {
  status: string
  severity: string
  limit: string
}

export const EMPTY_LOCK_UNIT_FORM: LockUnitFormState = {
  unitId: '',
  reason: '',
}

export const EMPTY_UNLOCK_UNIT_FORM: UnlockUnitFormState = {
  lockRecordId: '',
  releaseReason: '',
}

export const EMPTY_FRAUD_REPORT_FORM: FraudReportFormState = {
  status: '',
  severity: '',
  limit: '50',
}

export const LICENSE_OPTIONS: LicenseBody[] = ['CLC', 'ARMY', 'NONE']

export function toCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100)
}

export function createEditState(product: ProductListItem): EditFormState {
  return {
    productId: product.id,
    name: product.name,
    description: product.description ?? '',
    school: product.school ?? '',
    licenseBody: product.license_body,
    category: product.category,
    color: product.color ?? '',
    lifecycleStatus: product.lifecycle_status,
    size: product.size,
    styleKey: product.style_key,
    royaltyRate: '',
    costCents: '',
    retailPriceCents: String(product.retail_price_cents),
    isActive: true,
  }
}
