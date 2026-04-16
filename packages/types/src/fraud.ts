import type { UnitStatus } from './inventory'

// ─── Fraud Signal Source ──────────────────────────────────────────────────────

/**
 * Origin of a fraud signal that produced a FraudFlag.
 * Used to triage investigation priority and route to the correct authority.
 */
export type FraudSignalSource =
  | 'hologram_scan_fail'     // Hologram verification returned invalid
  | 'duplicate_serial'       // Same serial number submitted on multiple orders
  | 'duplicate_hologram'     // Hologram ID appears on more than one unit record
  | 'consultant_report'      // Consultant self-reported a suspected counterfeit
  | 'customer_report'        // Customer reported a product authenticity concern
  | 'licensor_report'        // CLC or Army flagged a unit in their audit
  | 'admin_manual'           // Admin flagged manually during investigation
  | 'payment_chargeback'     // Chargeback received; possible stolen card / resale fraud
  | 'velocity_anomaly'       // Unusual sale rate on a serial or consultant account

// ─── Fraud Flag Severity ──────────────────────────────────────────────────────

/**
 * Risk level assigned to a FraudFlag at creation.
 * Determines whether an automatic unit lock is applied and
 * the SLA for investigator response.
 *
 *   critical  → unit auto-locked; 24-hour investigator SLA
 *   high      → unit auto-locked; 72-hour investigator SLA
 *   medium    → no auto-lock; 7-day investigator SLA
 *   low       → no auto-lock; reviewed in next scheduled audit cycle
 */
export type FraudFlagSeverity = 'low' | 'medium' | 'high' | 'critical'

// ─── Fraud Flag Status ────────────────────────────────────────────────────────

/**
 * Investigation lifecycle for a FraudFlag.
 *
 *   open → under_review → confirmed → lock applied via LockRecord
 *                       → dismissed  (signal was a false positive)
 *   open → under_review → escalated → confirmed | dismissed
 */
export type FraudFlagStatus =
  | 'open'          // Signal received; not yet assigned to an investigator
  | 'under_review'  // Assigned; investigation in progress
  | 'escalated'     // Elevated to senior authority or licensor
  | 'confirmed'     // Fraud verified; LockRecord created or already in force
  | 'dismissed'     // False positive; no action taken; unit remains/restored to active

// ─── Lock Scope ───────────────────────────────────────────────────────────────

/**
 * What the LockRecord targets.
 * A single fraud event may produce locks at multiple scopes.
 * E.g. a confirmed counterfeit ring may lock both the unit and the consultant.
 */
export type LockScope =
  | 'unit'        // Specific SerializedUnit is locked (UnitStatus → fraud_locked)
  | 'consultant'  // ConsultantProfile.status → suspended
  | 'order'       // Order is frozen pending investigation

// ─── Lock Authority ───────────────────────────────────────────────────────────

/**
 * Who holds the authority to apply or lift a lock.
 * Authority must be recorded on every lock action for compliance.
 */
export type LockAuthority =
  | 'gtg_admin'   // Internal GTG administrator
  | 'clc'         // Collegiate Licensing Company
  | 'army'        // U.S. Army licensing authority
  | 'system'      // Automated lock triggered by severity rule (critical/high)

// ─── Fraud Flag ───────────────────────────────────────────────────────────────

/**
 * A fraud signal raised against a specific serialized unit.
 *
 * FraudFlag is the investigation record. It does not itself change unit status —
 * a LockRecord does. The flag drives the investigative workflow;
 * the lock drives the operational consequence.
 *
 * One unit may accumulate multiple FraudFlags over its lifetime.
 * Each flag is investigated independently. Confirming one flag does not
 * automatically dismiss others.
 *
 * Write policy: 'open' and 'under_review' flags are updateable.
 * Once 'confirmed' or 'dismissed', the flag is immutable.
 */
export interface FraudFlag {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Foreign key → serialized_units.id. */
  readonly unitId: string
  /** Denormalized serial number — preserved if unit is voided during investigation. */
  readonly serialNumber: string
  /** Denormalized SKU. */
  readonly sku: string
  /**
   * The signal that triggered this flag.
   * Determines initial severity assignment and investigation routing.
   */
  readonly source: FraudSignalSource
  /** Risk level at time of flag creation. */
  readonly severity: FraudFlagSeverity
  /** Current investigation status. */
  status: FraudFlagStatus
  /**
   * Unit status at the moment the flag was raised.
   * Denormalized — required to determine what state to restore
   * the unit to if the flag is dismissed and a lock must be released.
   */
  readonly unitStatusAtFlag: UnitStatus
  /**
   * Whether an automatic lock was applied when this flag was created.
   * True for severity 'high' and 'critical'.
   * Links to the auto-generated LockRecord via autoLockId.
   */
  readonly autoLocked: boolean
  /**
   * Foreign key → lock_records.id.
   * Populated when autoLocked is true or when an investigator manually locks.
   * Null if no lock has been applied for this flag.
   */
  readonly autoLockId: string | null
  /**
   * Order ID associated with the signal, if applicable.
   * Populated for: duplicate_serial, payment_chargeback.
   * Null for source types with no order context.
   */
  readonly relatedOrderId: string | null
  /**
   * Consultant ID associated with the signal, if applicable.
   * Populated for: consultant_report, velocity_anomaly.
   * Null for source types with no consultant context.
   */
  readonly relatedConsultantId: string | null
  /**
   * Licensor that submitted the report, if applicable.
   * Populated for: licensor_report.
   * Null for all other sources.
   */
  readonly reportingLicensor: 'CLC' | 'ARMY' | null
  /**
   * Raw signal payload — e.g. scan device ID, hologram verify response body,
   * chargeback notice reference. Stored for investigator context.
   * Never use this as a substitute for a typed field.
   */
  readonly signalMetadata: Record<string, string | number | boolean> | null
  /** Free-text description of the signal or initial observations. */
  readonly description: string
  /**
   * User ID who raised the flag.
   * For automated signals (hologram_scan_fail, velocity_anomaly), this is
   * the system service account ID.
   */
  readonly raisedBy: string
  /**
   * User ID of the investigator assigned to this flag.
   * Null until assigned (status leaves 'open').
   */
  assignedTo: string | null
  /**
   * ISO 8601 — when the flag was assigned to an investigator.
   * Null while status is 'open'.
   */
  assignedAt: string | null
  /**
   * Investigator notes accumulated during review.
   * Appended, not replaced — use a separator convention (e.g. dated entries).
   * Null until investigation begins.
   */
  investigationNotes: string | null
  /**
   * Escalation reason — required when status transitions to 'escalated'.
   * Null for non-escalated flags.
   */
  escalationReason: string | null
  /**
   * Final disposition note — required when status reaches 'confirmed' or 'dismissed'.
   * Must document the basis for the determination.
   */
  resolutionNote: string | null
  /**
   * ISO 8601 — when the flag was resolved (confirmed or dismissed).
   * Null while investigation is active.
   */
  resolvedAt: string | null
  /** User ID who closed the investigation. Null while active. */
  resolvedBy: string | null
  /** ISO 8601 — when this flag was created. */
  readonly createdAt: string
  /** ISO 8601 — last update to any mutable field. */
  updatedAt: string
}

// ─── Lock Record ──────────────────────────────────────────────────────────────

/**
 * An authoritative lock action applied to a unit, consultant, or order.
 *
 * LockRecord is the operational enforcement mechanism. Where FraudFlag
 * tracks the investigation, LockRecord tracks the lock itself —
 * who applied it, under what authority, and when (or whether) it was lifted.
 *
 * A single FraudFlag may produce multiple LockRecords across different scopes
 * (e.g. lock both the unit and the consultant simultaneously).
 * A LockRecord may exist without a FraudFlag (e.g. a licensor-mandated hold
 * that bypasses the internal investigation workflow).
 *
 * Write policy: append-only. A lock is never deleted.
 * Lifting a lock creates a new release entry (isActive → false),
 * preserving the full lock history on the record.
 *
 * Compliance requirement: every lock and every release must identify
 * the authority who authorized the action.
 */
export interface LockRecord {
  /** Database primary key (UUID v4). */
  readonly id: string
  /**
   * Foreign key → fraud_flags.id, if this lock was raised from a flag.
   * Null for licensor-mandated or admin-initiated locks without a prior flag.
   */
  readonly fraudFlagId: string | null
  /** What this lock targets. */
  readonly scope: LockScope
  /**
   * The ID of the locked entity, resolved by scope:
   *   scope = 'unit'       → serialized_units.id
   *   scope = 'consultant' → consultant_profiles.id
   *   scope = 'order'      → orders.id
   */
  readonly targetId: string
  /**
   * Denormalized human-readable label for the locked entity.
   *   scope = 'unit'       → serial number
   *   scope = 'consultant' → consultant legal name
   *   scope = 'order'      → order number
   * Preserved for audit display if the target record is later modified.
   */
  readonly targetLabel: string
  /** Authority under whose direction this lock was applied. */
  readonly lockAuthority: LockAuthority
  /**
   * Status of the target entity immediately before the lock was applied.
   * Required to restore correct state on release.
   * Typed as UnitStatus for unit locks; string for consultant/order
   * (their status enums are in other modules; avoid a circular import).
   */
  readonly statusBeforeLock: string
  /** Whether this lock is currently in force. */
  isActive: boolean
  /** Reason the lock was applied — required, never null. */
  readonly lockReason: string
  /**
   * External reference from the licensor authorizing this lock.
   * Populated for lockAuthority 'clc' or 'army'.
   * Null for internal locks.
   */
  readonly licensorReferenceId: string | null
  /**
   * User ID who applied the lock.
   * For lockAuthority 'system', this is the service account ID.
   */
  readonly lockedBy: string
  /** ISO 8601 — when the lock was applied. */
  readonly lockedAt: string
  /**
   * Reason the lock was lifted.
   * Required when isActive transitions to false.
   * Null while lock is in force.
   */
  releaseReason: string | null
  /**
   * Authority who authorized the lock release.
   * Must be recorded — a lock applied by 'army' cannot be released
   * without army authority.
   * Null while lock is in force.
   */
  releaseAuthority: LockAuthority | null
  /**
   * External reference from the licensor authorizing the release.
   * Populated for releaseAuthority 'clc' or 'army'.
   * Null for internal releases or while lock is active.
   */
  readonly releaseReferenceId: string | null
  /** User ID who released the lock. Null while lock is in force. */
  releasedBy: string | null
  /**
   * ISO 8601 — when the lock was lifted.
   * Null while isActive is true.
   */
  releasedAt: string | null
  /** ISO 8601 — when this record was created. */
  readonly createdAt: string
  /** ISO 8601 — last update (isActive change or release fields populated). */
  updatedAt: string
}
