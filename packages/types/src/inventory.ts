// ─── Unit Status ─────────────────────────────────────────────────────────────

/**
 * Lifecycle states for a serialized physical unit.
 * Transitions are one-directional except fraud_locked → available (release).
 *
 *   available → reserved → sold
 *   any       → fraud_locked
 *   fraud_locked → available
 *   any       → voided
 *   sold      → returned → available
 */
export type UnitStatus =
  | 'available'
  | 'reserved'
  | 'sold'
  | 'fraud_locked'
  | 'returned'
  | 'voided'

// ─── License Body ─────────────────────────────────────────────────────────────

/** Collegiate Licensing Company or U.S. Army — the royalty-bearing authority. */
export type LicenseBody = 'CLC' | 'ARMY' | 'NONE'

// ─── Hologram Record ──────────────────────────────────────────────────────────

/**
 * The physical hologram affixed to a serialized unit.
 * Serial number and hologram ID must be 1:1 — never share across units.
 */
export interface HologramRecord {
  /** Hologram manufacturer's unique identifier (printed on label). */
  readonly hologramId: string
  /** Batch/lot number from the hologram supplier. */
  readonly batchId: string
  /** ISO 8601 date the hologram was applied to the unit. */
  readonly appliedAt: string
  /** Operator who applied the hologram (user ID). */
  readonly appliedBy: string
  /** Optional scan URL base — full URL = verifyBaseUrl + hologramId. */
  readonly verifyBaseUrl: string | null
}

// ─── Serialized Unit ──────────────────────────────────────────────────────────

/**
 * A single physical, serialized inventory item.
 *
 * Each unit maps 1:1 to a hologram and a serial number.
 * The serial number is immutable after creation.
 * Royalty obligations are captured at the unit level so that
 * ledger entries carry a complete audit trail independent of
 * any product catalog changes.
 */
export interface SerializedUnit {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Immutable serial number — encoded on the hologram and packaging. */
  readonly serialNumber: string
  /** Product catalog SKU this unit belongs to. */
  readonly sku: string
  /** Foreign key → products table. */
  readonly productId: string
  /** Human-readable product name, denormalized for ledger integrity. */
  readonly productName: string
  /** Current lifecycle status. */
  status: UnitStatus
  /** Hologram authentication record. Null until hologram is applied. */
  readonly hologram: HologramRecord | null
  /** Licensing body governing this unit's royalty obligations. */
  readonly licenseBody: LicenseBody
  /**
   * Royalty rate as a decimal fraction (e.g. 0.145 = 14.5%).
   * Captured at creation — not retroactively changed if rate table updates.
   */
  readonly royaltyRate: number
  /** Wholesale cost in cents (USD). */
  readonly costCents: number
  /** Retail price in cents (USD) at time of last sale. Null if unsold. */
  retailPriceCents: number | null
  /** Order ID if currently reserved or sold. Null otherwise. */
  orderId: string | null
  /** Consultant who sold this unit. Null until sold. */
  consultantId: string | null
  /** ISO 8601 — when unit entered the system. */
  readonly receivedAt: string
  /** ISO 8601 — when sold. Null if unsold. */
  soldAt: string | null
  /** ISO 8601 — when returned. Null if not returned. */
  returnedAt: string | null
  /** ISO 8601 — when fraud lock was applied. Null if not locked. */
  fraudLockedAt: string | null
  /** User ID who applied the fraud lock. Null if not locked. */
  fraudLockedBy: string | null
  /** Reason recorded when fraud lock was applied. Null if not locked. */
  fraudLockReason: string | null
  /** ISO 8601 timestamp of last status change. */
  updatedAt: string
}

// ─── Ledger Action ────────────────────────────────────────────────────────────

/**
 * All actions that produce an immutable ledger entry.
 * Entries are append-only — never updated or deleted.
 */
export type LedgerAction =
  | 'received'        // Unit entered inventory
  | 'hologram_applied'// Hologram affixed
  | 'reserved'        // Held against an order
  | 'reservation_released' // Hold cancelled (order void/timeout)
  | 'sold'            // Ownership transferred
  | 'returned'        // Customer return accepted
  | 'fraud_locked'    // Fraud authority locked the unit
  | 'fraud_released'  // Fraud lock lifted
  | 'voided'          // Unit destroyed / written off

// ─── Inventory Ledger Entry ──────────────────────────────────────────────────

/**
 * Immutable audit record for every state change on a SerializedUnit.
 *
 * The ledger is the source of truth for compliance reporting.
 * Fields are denormalized by design — the record must be self-contained
 * even if upstream records are amended or deleted.
 *
 * Write policy: insert-only. No UPDATE or DELETE on this table ever.
 */
export interface InventoryLedgerEntry {
  /** Database primary key (UUID v4). */
  readonly id: string
  /** Foreign key → serialized_units.id. */
  readonly unitId: string
  /** Denormalized serial number — preserved if unit record is voided. */
  readonly serialNumber: string
  /** Denormalized SKU. */
  readonly sku: string
  /** Denormalized product name. */
  readonly productName: string
  /** The action that produced this entry. */
  readonly action: LedgerAction
  /** Unit status before this action. Null for the initial 'received' entry. */
  readonly fromStatus: UnitStatus | null
  /** Unit status after this action. */
  readonly toStatus: UnitStatus
  /** User ID of the operator who performed the action. */
  readonly performedBy: string
  /**
   * Order ID at time of action.
   * Populated for: reserved, reservation_released, sold, returned.
   * Null for all other actions.
   */
  readonly orderId: string | null
  /**
   * Consultant ID at time of action.
   * Populated for: sold, returned.
   * Null for all other actions.
   */
  readonly consultantId: string | null
  /**
   * Licensing body at time of action — denormalized.
   * Royalty reports join on this field, not on the unit record.
   */
  readonly licenseBody: LicenseBody
  /**
   * Royalty rate at time of action — denormalized.
   * Rate changes on the product do not affect historical ledger entries.
   */
  readonly royaltyRate: number
  /**
   * Retail price in cents at time of action.
   * Populated for: sold, returned. Null for other actions.
   */
  readonly retailPriceCents: number | null
  /** Free-text reason — required for: fraud_locked, fraud_released, voided. */
  readonly reason: string | null
  /**
   * Arbitrary structured metadata for extensibility.
   * E.g. shipping carrier, scan device ID, return condition.
   * Never use this as a substitute for a typed field.
   */
  readonly metadata: Record<string, string | number | boolean> | null
  /** ISO 8601 — wall-clock time of the action (server-generated, UTC). */
  readonly occurredAt: string
}
