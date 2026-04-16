import type { LicenseBody } from './inventory'

// ─── Reporting Period ─────────────────────────────────────────────────────────

/**
 * Royalty reporting cadence.
 * CLC requires quarterly reports; Army requires monthly.
 * The period type is captured on every RoyaltyEntry so reports
 * can be filtered without joining to a calendar table.
 */
export type ReportingPeriod = 'monthly' | 'quarterly' | 'annual'

// ─── Royalty Status ───────────────────────────────────────────────────────────

/**
 * Lifecycle of a royalty obligation.
 *
 *   calculated → submitted → acknowledged → paid
 *                          → disputed → resolved → paid
 *   any        → voided
 */
export type RoyaltyStatus =
  | 'calculated'    // Computed from ledger; not yet submitted to licensor
  | 'submitted'     // Report filed with CLC or Army
  | 'acknowledged'  // Licensor confirmed receipt
  | 'disputed'      // Licensor raised a discrepancy
  | 'resolved'      // Dispute closed; corrected amount agreed
  | 'paid'          // Payment cleared
  | 'voided'        // Entry invalidated (e.g. duplicate, system error)

// ─── License Holder ───────────────────────────────────────────────────────────

/**
 * The entity to whom royalties are owed — CLC, U.S. Army, or a co-licensor.
 *
 * A LicenseHolder is the contractual counterparty for a given LicenseBody.
 * Multiple products may belong to the same LicenseHolder.
 * Rate agreements are versioned — a new record is created when rates change;
 * existing RoyaltyEntry records reference the rate at time of sale.
 *
 * Write policy: rates are append-only. Never mutate an existing rate record.
 */
export interface LicenseHolder {
  /** Database primary key (UUID v4). */
  readonly id: string
  /**
   * Canonical license body this holder represents.
   * Determines reporting format and submission destination.
   */
  readonly licenseBody: LicenseBody
  /** Legal entity name as it appears on the license agreement. */
  readonly legalName: string
  /**
   * Short code used in report filenames and internal references.
   * E.g. 'CLC', 'ARMY-IPR'.
   */
  readonly code: string
  /**
   * Primary contact name at the licensing authority.
   * Used for report submission correspondence.
   */
  readonly contactName: string
  /** Contact email — royalty reports are submitted here. */
  readonly contactEmail: string
  /**
   * Royalty rate as a decimal fraction (e.g. 0.145 = 14.5%).
   * Captured per-holder; individual products may override at product level.
   * This is the default rate applied when no product-level override exists.
   */
  readonly defaultRoyaltyRate: number
  /**
   * Minimum royalty due per reporting period in cents (USD).
   * If total calculated royalties fall below this, the minimum is remitted.
   * Null if the agreement has no minimum.
   */
  readonly minimumRoyaltyCents: number | null
  /** Required reporting cadence under the license agreement. */
  readonly reportingPeriod: ReportingPeriod
  /** ISO 8601 date the current rate agreement became effective. */
  readonly rateEffectiveDate: string
  /**
   * ISO 8601 date the current rate expires.
   * Null for open-ended agreements. A new LicenseHolder record is created
   * when the rate changes — this field marks the old record's end.
   */
  readonly rateExpiryDate: string | null
  /** Whether this holder record is the currently active rate agreement. */
  readonly isActive: boolean
  /** ISO 8601 — when this record was created. */
  readonly createdAt: string
  /** User ID who created this record. */
  readonly createdBy: string
}

// ─── Royalty Entry ────────────────────────────────────────────────────────────

/**
 * A single royalty obligation record, aggregated from InventoryLedgerEntry
 * rows for a given reporting period and license body.
 *
 * RoyaltyEntry is the unit of submission to CLC and Army.
 * One entry covers one licenseBody for one reporting period.
 * It references the ledger entries it was computed from via
 * `ledgerEntryIds` — enabling full auditability of every dollar.
 *
 * Write policy: `calculated` entries may be amended before submission.
 * Once status reaches `submitted`, the entry is effectively immutable;
 * corrections require a new entry with an offsetting adjustment.
 */
export interface RoyaltyEntry {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Foreign key → license_holders.id. */
  readonly licenseHolderId: string
  /**
   * Denormalized license body — preserved for reporting if the
   * LicenseHolder record is later superseded by a new rate version.
   */
  readonly licenseBody: LicenseBody
  /**
   * Denormalized legal name at time of submission.
   * Ensures report headers are accurate even if legalName is corrected.
   */
  readonly licenseHolderName: string
  /** Period type that governs this entry's date range. */
  readonly reportingPeriod: ReportingPeriod
  /** ISO 8601 date — first day of the reporting period (inclusive). */
  readonly periodStart: string
  /** ISO 8601 date — last day of the reporting period (inclusive). */
  readonly periodEnd: string
  /**
   * IDs of every InventoryLedgerEntry with action 'sold' that contributed
   * to this royalty calculation. Order is not significant.
   * Required for audit — must be complete before status advances past
   * 'calculated'.
   */
  readonly ledgerEntryIds: readonly string[]
  /** Number of units sold in this period that bear this license. */
  readonly unitsSold: number
  /** Total gross retail sales in cents (USD) for the covered units. */
  readonly grossSalesCents: number
  /**
   * Royalty rate applied to this entry as a decimal fraction.
   * Captured at calculation time — immune to future rate changes.
   */
  readonly royaltyRate: number
  /**
   * Calculated royalty amount in cents (USD).
   * = grossSalesCents × royaltyRate, rounded to nearest cent.
   */
  readonly royaltyCents: number
  /**
   * Minimum royalty applied in cents (USD).
   * Equal to LicenseHolder.minimumRoyaltyCents if royaltyCents fell below
   * the minimum; otherwise equals royaltyCents.
   * This is the amount actually remitted.
   */
  readonly remittanceCents: number
  /**
   * True when the minimum royalty floor was applied.
   * Signals to the report renderer to include a minimum-applied note.
   */
  readonly minimumApplied: boolean
  /** Current status of this royalty obligation. */
  status: RoyaltyStatus
  /**
   * Identifier assigned by the licensor upon submission acknowledgement.
   * Null until the licensor acknowledges receipt.
   */
  licensorReferenceId: string | null
  /**
   * ISO 8601 date the report was submitted to the licensor.
   * Null while status is 'calculated'.
   */
  submittedAt: string | null
  /** User ID who submitted the report. Null while unsubmitted. */
  submittedBy: string | null
  /**
   * ISO 8601 date payment cleared.
   * Null until status reaches 'paid'.
   */
  paidAt: string | null
  /**
   * Payment reference (check number, wire reference, ACH trace ID).
   * Null until status reaches 'paid'.
   */
  paymentReference: string | null
  /**
   * Dispute description if status is 'disputed'.
   * Preserved after resolution for audit record.
   */
  disputeNote: string | null
  /**
   * Resolution note populated when dispute is closed.
   * Null if no dispute occurred.
   */
  resolutionNote: string | null
  /**
   * Adjusted remittance in cents (USD) agreed upon after dispute resolution.
   * Null if no dispute or if resolved with original amount.
   */
  adjustedRemittanceCents: number | null
  /** ISO 8601 — when this entry was first calculated. */
  readonly createdAt: string
  /** User ID who ran the royalty calculation. */
  readonly createdBy: string
  /** ISO 8601 — last status update. */
  updatedAt: string
}
