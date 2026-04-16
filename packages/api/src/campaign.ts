/**
 * Promotional campaign and discount code operations.
 *
 * Campaigns are admin-created promotional events that can issue discount codes
 * applied by customers at checkout. A campaign defines the discount type and
 * value; a discount code is the storefront-facing redemption token.
 *
 * The `discount_code` field on the orders table is the source of truth for
 * which campaign influenced a given order. It is applied during checkout
 * via `createCheckoutSession` in orders.ts.
 *
 * DB note: The `campaigns` table is defined in the Phase 2 schema migration.
 * The Edge Functions referenced here (`create-campaign`, `update-campaign`,
 * `list-campaigns`, `validate-discount-code`) are created alongside that
 * migration. The API wrapper layer is specified here first as the contract.
 */

import { ApiRequestError } from './error'
import { assertUuidV4 } from './_internal'
import { invokeFunction } from './transport'

// ─── Campaign Types ───────────────────────────────────────────────────────────

/** Lifecycle of a promotional campaign. */
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended'

/**
 * How the discount amount is applied at checkout.
 *   percentage  — `discountValue` is a percent (0–100). Applied to subtotal.
 *   fixed_cents — `discountValue` is a fixed dollar amount in cents (USD).
 */
export type DiscountType = 'percentage' | 'fixed_cents'

const VALID_CAMPAIGN_STATUSES: CampaignStatus[] = ['draft', 'active', 'paused', 'ended']
const VALID_DISCOUNT_TYPES: DiscountType[] = ['percentage', 'fixed_cents']

/** A promotional campaign record. */
export interface Campaign {
  id: string
  name: string
  description: string | null
  status: CampaignStatus
  discount_type: DiscountType
  /**
   * The discount value.
   *   - When discount_type is 'percentage': integer 1–100 (percent).
   *   - When discount_type is 'fixed_cents': positive integer (USD cents).
   */
  discount_value: number
  /**
   * The redemption code customers enter at checkout.
   * Null means the campaign applies automatically (no code required).
   * Codes are case-insensitive and stored uppercase.
   */
  code: string | null
  /** Maximum number of redemptions. Null = unlimited. */
  max_uses: number | null
  /** Number of times the code has been successfully redeemed. */
  uses_count: number
  /** ISO 8601 — when the campaign becomes active. */
  starts_at: string
  /** ISO 8601 — when the campaign ends. Null = no end date. */
  ends_at: string | null
  created_at: string
  updated_at: string
}

// ─── List Campaigns ───────────────────────────────────────────────────────────

export interface ListCampaignsInput {
  status?: CampaignStatus
  limit?: number
  offset?: number
}

export interface ListCampaignsResult {
  campaigns: Campaign[]
  total: number
  limit: number
  offset: number
}

/**
 * List promotional campaigns.
 *
 * Admins see all campaigns. Storefront callers receive only 'active' campaigns
 * — access scope is enforced server-side.
 */
export async function listCampaigns(input: ListCampaignsInput = {}): Promise<ListCampaignsResult> {
  const { status, limit, offset } = input

  if (status !== undefined && !VALID_CAMPAIGN_STATUSES.includes(status)) {
    throw new ApiRequestError(
      `[GTG] listCampaigns(): status must be one of ${VALID_CAMPAIGN_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR',
    )
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new ApiRequestError(
      '[GTG] listCampaigns(): limit must be an integer between 1 and 200.',
      'VALIDATION_ERROR',
    )
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new ApiRequestError(
      '[GTG] listCampaigns(): offset must be a non-negative integer.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<ListCampaignsResult>(
    'list-campaigns',
    {
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
    'listCampaigns',
  )
}

// ─── Validate Discount Code ───────────────────────────────────────────────────

export interface ValidateDiscountCodeInput {
  code: string
  /** Optional — validate eligibility for a specific product. */
  productId?: string
}

export interface ValidateDiscountCodeResult {
  valid: boolean
  campaign_id: string | null
  campaign_name: string | null
  discount_type: DiscountType | null
  discount_value: number | null
  /** Computed discount amount in cents for the product, if productId was provided. */
  discount_cents: number | null
  /** Human-readable rejection reason when valid is false. */
  rejection_reason: string | null
}

/**
 * Validate a discount code before applying it to an order.
 *
 * Call this from the storefront before `createCheckoutSession` to show
 * the customer the discount amount. The checkout session creation also
 * validates the code server-side — this call is for UI feedback only.
 */
export async function validateDiscountCode(
  input: ValidateDiscountCodeInput,
): Promise<ValidateDiscountCodeResult> {
  const { code, productId } = input

  if (!code || code.trim().length === 0) {
    throw new ApiRequestError(
      '[GTG] validateDiscountCode(): code is required.',
      'VALIDATION_ERROR',
    )
  }
  if (productId !== undefined) {
    assertUuidV4(productId, 'productId', 'validateDiscountCode')
  }

  return invokeFunction<ValidateDiscountCodeResult>(
    'validate-discount-code',
    {
      code: code.trim().toUpperCase(),
      ...(productId ? { product_id: productId } : {}),
    },
    'validateDiscountCode',
  )
}

// ─── Create Campaign ──────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string
  description?: string
  discountType: DiscountType
  /**
   * Discount value.
   *   - 'percentage': integer 1–100.
   *   - 'fixed_cents': positive integer.
   */
  discountValue: number
  /** Redemption code. Uppercase enforced. Omit for automatic (no-code) campaigns. */
  code?: string
  maxUses?: number
  startsAt: string
  endsAt?: string
}

/**
 * Create a new promotional campaign (admin only).
 * Campaigns start in 'draft' status. Use `updateCampaign` to activate.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const { name, description, discountType, discountValue, code, maxUses, startsAt, endsAt } = input

  if (!name?.trim()) {
    throw new ApiRequestError('[GTG] createCampaign(): name is required.', 'VALIDATION_ERROR')
  }
  if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
    throw new ApiRequestError(
      `[GTG] createCampaign(): discountType must be one of ${VALID_DISCOUNT_TYPES.join(', ')}.`,
      'VALIDATION_ERROR',
    )
  }
  if (
    discountType === 'percentage' &&
    (!Number.isInteger(discountValue) || discountValue < 1 || discountValue > 100)
  ) {
    throw new ApiRequestError(
      '[GTG] createCampaign(): discountValue must be an integer 1–100 for percentage type.',
      'VALIDATION_ERROR',
    )
  }
  if (discountType === 'fixed_cents' && (!Number.isInteger(discountValue) || discountValue < 1)) {
    throw new ApiRequestError(
      '[GTG] createCampaign(): discountValue must be a positive integer for fixed_cents type.',
      'VALIDATION_ERROR',
    )
  }
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new ApiRequestError(
      '[GTG] createCampaign(): maxUses must be a positive integer.',
      'VALIDATION_ERROR',
    )
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(startsAt)) {
    throw new ApiRequestError(
      '[GTG] createCampaign(): startsAt must be an ISO 8601 date or datetime.',
      'VALIDATION_ERROR',
    )
  }
  if (endsAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(endsAt)) {
    throw new ApiRequestError(
      '[GTG] createCampaign(): endsAt must be an ISO 8601 date or datetime.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<Campaign>(
    'create-campaign',
    {
      name: name.trim(),
      ...(description?.trim() ? { description: description.trim() } : {}),
      discount_type: discountType,
      discount_value: discountValue,
      ...(code?.trim() ? { code: code.trim().toUpperCase() } : {}),
      ...(maxUses !== undefined ? { max_uses: maxUses } : {}),
      starts_at: startsAt,
      ...(endsAt ? { ends_at: endsAt } : {}),
    },
    'createCampaign',
  )
}

// ─── Update Campaign ──────────────────────────────────────────────────────────

export interface UpdateCampaignInput {
  campaignId: string
  status?: Exclude<CampaignStatus, 'draft'>
  name?: string
  description?: string | null
  endsAt?: string | null
}

/**
 * Update a campaign's status or metadata (admin only).
 *
 * Use this to activate a draft campaign (`status: 'active'`), pause it
 * (`status: 'paused'`), or mark it ended (`status: 'ended'`).
 */
export async function updateCampaign(input: UpdateCampaignInput): Promise<Campaign> {
  const { campaignId, status, name, description, endsAt } = input

  if (!campaignId || typeof campaignId !== 'string') {
    throw new ApiRequestError('[GTG] updateCampaign(): campaignId is required.', 'VALIDATION_ERROR')
  }
  assertUuidV4(campaignId, 'campaignId', 'updateCampaign')

  if (status === undefined && name === undefined && description === undefined && endsAt === undefined) {
    throw new ApiRequestError(
      '[GTG] updateCampaign(): at least one field must be provided.',
      'VALIDATION_ERROR',
    )
  }
  if (status !== undefined && !VALID_CAMPAIGN_STATUSES.includes(status)) {
    throw new ApiRequestError(
      `[GTG] updateCampaign(): status must be one of ${VALID_CAMPAIGN_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR',
    )
  }
  if (name !== undefined && name.trim().length === 0) {
    throw new ApiRequestError('[GTG] updateCampaign(): name cannot be blank.', 'VALIDATION_ERROR')
  }
  if (endsAt !== null && endsAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(endsAt)) {
    throw new ApiRequestError(
      '[GTG] updateCampaign(): endsAt must be an ISO 8601 date or datetime.',
      'VALIDATION_ERROR',
    )
  }

  return invokeFunction<Campaign>(
    'update-campaign',
    {
      campaign_id: campaignId,
      ...(status !== undefined ? { status } : {}),
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(endsAt !== undefined ? { ends_at: endsAt } : {}),
    },
    'updateCampaign',
  )
}
