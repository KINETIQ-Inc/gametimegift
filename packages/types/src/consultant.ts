// ─── Consultant Status ────────────────────────────────────────────────────────

/**
 * Lifecycle states for a consultant account.
 *
 *   pending_approval → active
 *   active           → suspended → active   (temporary hold)
 *   active           → terminated           (permanent)
 *   suspended        → terminated
 */
export type ConsultantStatus =
  | 'pending_approval' // Application submitted; awaiting admin review
  | 'active'           // Approved and earning commissions
  | 'suspended'        // Temporarily blocked from new sales; commissions held
  | 'terminated'       // Permanently removed; no further commission accrual

// ─── Commission Tier ──────────────────────────────────────────────────────────

/**
 * Commission rate tier assigned to a consultant.
 * Tiers are configured in the admin panel and referenced here by name.
 * Rate values live in the commission tier config, not on the consultant record,
 * so rate changes apply forward without requiring a profile update.
 *
 * The tier at time of sale is denormalized onto CommissionEntry.
 */
export type CommissionTier = 'standard' | 'senior' | 'elite' | 'custom'

// ─── Commission Entry Status ──────────────────────────────────────────────────

/**
 * Lifecycle of a single commission obligation.
 *
 *   earned → approved → paid
 *   earned → held     → approved → paid   (suspended consultant or disputed sale)
 *   earned → reversed                     (order returned / fraud confirmed)
 *   any    → voided                       (system correction)
 */
export type CommissionStatus =
  | 'earned'    // Sale completed; commission calculated; pending approval
  | 'held'      // Withheld pending resolution (suspension, fraud review)
  | 'approved'  // Cleared for payout
  | 'paid'      // Disbursed to consultant
  | 'reversed'  // Clawed back due to return or confirmed fraud
  | 'voided'    // Invalidated by system correction

// ─── Address ──────────────────────────────────────────────────────────────────

/** Mailing/payment address — used for 1099 reporting. */
export interface ConsultantAddress {
  readonly line1: string
  readonly line2: string | null
  readonly city: string
  /** Two-letter state code (US) or province code (CA). */
  readonly state: string
  readonly postalCode: string
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string
}

// ─── Consultant Profile ───────────────────────────────────────────────────────

/**
 * A registered Game Time Gift sales consultant.
 *
 * Consultants sell serialized units on behalf of GTG and earn commissions
 * on completed sales. They are subject to fraud lock authority — a suspended
 * or terminated consultant's pending commissions are held until resolution.
 *
 * Tax fields (taxId, address) are required before any commission payout
 * and before 1099 generation at year end.
 */
export interface ConsultantProfile {
  /** Database primary key (UUID v4). */
  readonly id: string
  /**
   * Foreign key → auth.users.id (Supabase Auth).
   * 1:1 with the consultant's login identity.
   */
  readonly authUserId: string
  /** Current account status. */
  status: ConsultantStatus
  /** Legal first name — used on 1099 and commission statements. */
  readonly legalFirstName: string
  /** Legal last name — used on 1099 and commission statements. */
  readonly legalLastName: string
  /** Preferred display name shown in the consultant portal. */
  displayName: string
  /** Primary contact email (may differ from auth email). */
  email: string
  /** Phone number in E.164 format (e.g. +12125550100). Null until provided. */
  phone: string | null
  /**
   * Tax identification number (SSN or EIN) for 1099 reporting.
   * Stored encrypted at rest — never logged or transmitted in plaintext.
   * Null until the consultant completes tax onboarding.
   */
  taxId: string | null
  /**
   * Whether the consultant has completed W-9 / tax onboarding.
   * No commission payout may occur while false.
   */
  taxOnboardingComplete: boolean
  /** Mailing address for 1099 delivery. Null until tax onboarding complete. */
  address: ConsultantAddress | null
  /** Assigned commission tier. Governs default commission rate. */
  commissionTier: CommissionTier
  /**
   * Custom commission rate override as a decimal fraction.
   * Only valid when commissionTier is 'custom'.
   * Null for all other tiers — rate is resolved from the tier config.
   */
  customCommissionRate: number | null
  /**
   * Cumulative lifetime gross sales in cents (USD).
   * Maintained as a running total — not recomputed from ledger on every read.
   * Source of truth for tier promotion thresholds.
   */
  lifetimeGrossSalesCents: number
  /**
   * Cumulative lifetime commissions earned in cents (USD).
   * Includes all statuses except 'voided'.
   * Used for 1099 year-end totals.
   */
  lifetimeCommissionsCents: number
  /**
   * Total commissions currently in 'approved' status awaiting payout.
   * Decremented when a payout batch is processed.
   */
  pendingPayoutCents: number
  /**
   * Referral/upline consultant ID.
   * Null for top-level consultants.
   * Used if override commission structure is introduced in a future phase.
   */
  readonly referredBy: string | null
  /**
   * ISO 8601 date the account was approved and activated.
   * Null while status is 'pending_approval'.
   */
  activatedAt: string | null
  /**
   * ISO 8601 date of most recent sale.
   * Null if no sales recorded. Updated on every completed sale.
   */
  lastSaleAt: string | null
  /**
   * ISO 8601 date account was suspended or terminated.
   * Null while active. Preserved after reactivation for audit history.
   */
  statusChangedAt: string | null
  /** User ID (admin) who last changed the status. */
  statusChangedBy: string | null
  /** Reason recorded when status was changed. Required for suspend/terminate. */
  statusChangeReason: string | null
  /** ISO 8601 — when this profile was created. */
  readonly createdAt: string
  /** ISO 8601 — last modification to any mutable field. */
  updatedAt: string
}

// ─── Commission Entry ─────────────────────────────────────────────────────────

/**
 * A single commission obligation tied to one sold SerializedUnit.
 *
 * One unit sale → one CommissionEntry. There is no aggregation at this level;
 * payout batches are assembled from multiple approved CommissionEntry rows.
 *
 * Denormalization policy: rate, tier, unit serial number, and sale amounts
 * are captured at creation time. They do not change if the consultant's tier
 * or the product's price changes after the fact.
 *
 * Write policy: 'earned' entries may be updated to 'held', 'approved',
 * 'reversed', or 'voided'. Once 'paid', the entry is immutable.
 * Corrections after payment require a new offsetting entry.
 */
export interface CommissionEntry {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Foreign key → consultant_profiles.id. */
  readonly consultantId: string
  /** Denormalized consultant legal name at time of sale. */
  readonly consultantName: string
  /**
   * Foreign key → serialized_units.id.
   * One CommissionEntry per unit — never aggregated across units.
   */
  readonly unitId: string
  /** Denormalized serial number — preserved if unit is later voided. */
  readonly serialNumber: string
  /** Denormalized SKU. */
  readonly sku: string
  /** Denormalized product name. */
  readonly productName: string
  /** Foreign key → orders.id. */
  readonly orderId: string
  /** Retail price in cents (USD) at time of sale. Basis for commission calc. */
  readonly retailPriceCents: number
  /**
   * Commission tier active at time of sale.
   * Denormalized — tier changes do not retroactively alter earned commissions.
   */
  readonly commissionTier: CommissionTier
  /**
   * Effective commission rate as a decimal fraction at time of sale.
   * Resolved from tier config or customCommissionRate if tier is 'custom'.
   */
  readonly commissionRate: number
  /**
   * Commission amount earned in cents (USD).
   * = retailPriceCents × commissionRate, rounded to nearest cent.
   */
  readonly commissionCents: number
  /** Current status of this commission obligation. */
  status: CommissionStatus
  /**
   * Reason commission was placed in 'held' status.
   * Null unless status is or was 'held'.
   */
  holdReason: string | null
  /**
   * Reason commission was reversed.
   * Required when status transitions to 'reversed'.
   * Null for all other statuses.
   */
  reversalReason: string | null
  /**
   * Foreign key → payout_batches.id.
   * Populated when the commission is included in a payout run.
   * Null until status reaches 'paid'.
   */
  payoutBatchId: string | null
  /**
   * ISO 8601 — when the commission was approved for payout.
   * Null while status is 'earned' or 'held'.
   */
  approvedAt: string | null
  /** User ID (admin) who approved the commission. */
  approvedBy: string | null
  /**
   * ISO 8601 — when the payout was disbursed.
   * Null until status reaches 'paid'.
   */
  paidAt: string | null
  /**
   * ISO 8601 — when the commission was reversed.
   * Null unless status is 'reversed'.
   */
  reversedAt: string | null
  /** ISO 8601 — when this entry was created (at time of sale). */
  readonly createdAt: string
  /** ISO 8601 — last status change. */
  updatedAt: string
}
