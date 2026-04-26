/**
 * Placeholder Database type.
 *
 * Mirrors the structure produced by:
 *   pnpm --filter @gtg/supabase gen:types
 *
 * This file documents the intended schema in terms the TypeScript compiler
 * can enforce today, before the Supabase project and migrations exist.
 * Every table, enum, and column name here must match what the SQL schema
 * will define — this is the binding contract between the type system and
 * the database.
 *
 * REPLACEMENT POLICY
 * ------------------
 * Once the schema is live (Phase 4), run:
 *   pnpm --filter @gtg/supabase gen:types
 *
 * That command overwrites this file entirely. Do not hand-edit the generated
 * version. If you need to fix a type, fix the SQL schema and regenerate.
 *
 * COLUMN NAMING
 * -------------
 * PostgreSQL uses snake_case. TypeScript interfaces in @gtg/types use
 * camelCase. These Row types use snake_case to match the actual column
 * names — they are NOT the same as the domain interfaces.
 *
 * ENUMS
 * -----
 * PostgreSQL enums are imported from @gtg/types and reused verbatim.
 * The enum value sets must be kept in sync. If a value is added to a
 * TypeScript union, a corresponding SQL ALTER TYPE must be written.
 */

import type {
  UnitStatus,
  LicenseBody,
  LedgerAction,
  ReportingPeriod,
  RoyaltyStatus,
  ConsultantStatus,
  CommissionTier,
  CommissionStatus,
  OrderStatus,
  OrderLineStatus,
  PaymentMethod,
  FulfillmentChannel,
  FraudSignalSource,
  FraudFlagSeverity,
  FraudFlagStatus,
  LockScope,
  LockAuthority,
} from '@gtg/types'

// ─── Json ─────────────────────────────────────────────────────────────────────

/**
 * Maps to PostgreSQL jsonb. Used for JSONB columns such as:
 *   serialized_units.hologram       — HologramRecord snapshot
 *   inventory_ledger_entries.metadata
 *   fraud_flags.signal_metadata
 *   lock_records (no JSONB currently)
 */
type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

// ─── Database ─────────────────────────────────────────────────────────────────

export type Database = {
  public: {
    Tables: {

      // ── serialized_units ──────────────────────────────────────────────────
      serialized_units: {
        Row: {
          id: string
          serial_number: string
          sku: string
          product_id: string
          product_name: string
          status: UnitStatus
          /** HologramRecord stored as JSONB. Null until hologram is applied. */
          hologram: Json | null
          license_body: LicenseBody
          royalty_rate: number
          cost_cents: number
          retail_price_cents: number | null
          order_id: string | null
          consultant_id: string | null
          received_at: string
          sold_at: string | null
          returned_at: string | null
          fraud_locked_at: string | null
          fraud_locked_by: string | null
          fraud_lock_reason: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          serial_number: string
          sku: string
          product_id: string
          product_name: string
          status?: UnitStatus
          hologram?: Json | null
          license_body: LicenseBody
          royalty_rate: number
          cost_cents: number
          retail_price_cents?: number | null
          order_id?: string | null
          consultant_id?: string | null
          received_at?: string
          sold_at?: string | null
          returned_at?: string | null
          fraud_locked_at?: string | null
          fraud_locked_by?: string | null
          fraud_lock_reason?: string | null
          updated_at?: string
        }
        Update: {
          status?: UnitStatus
          hologram?: Json | null
          retail_price_cents?: number | null
          order_id?: string | null
          consultant_id?: string | null
          sold_at?: string | null
          returned_at?: string | null
          fraud_locked_at?: string | null
          fraud_locked_by?: string | null
          fraud_lock_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── inventory_ledger_entries ───────────────────────────────────────────
      // Append-only. No Update type intentionally omitted from usage;
      // included here as empty to satisfy the Database shape.
      inventory_ledger_entries: {
        Row: {
          id: string
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          action: LedgerAction
          from_status: UnitStatus | null
          to_status: UnitStatus
          performed_by: string
          order_id: string | null
          consultant_id: string | null
          license_body: LicenseBody
          royalty_rate: number
          retail_price_cents: number | null
          reason: string | null
          metadata: Json | null
          occurred_at: string
        }
        Insert: {
          id?: string
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          action: LedgerAction
          from_status?: UnitStatus | null
          to_status: UnitStatus
          performed_by: string
          order_id?: string | null
          consultant_id?: string | null
          license_body: LicenseBody
          royalty_rate: number
          retail_price_cents?: number | null
          reason?: string | null
          metadata?: Json | null
          occurred_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }

      // ── license_holders ───────────────────────────────────────────────────
      license_holders: {
        Row: {
          id: string
          license_body: LicenseBody
          legal_name: string
          code: string
          contact_name: string
          contact_email: string
          default_royalty_rate: number
          minimum_royalty_cents: number | null
          reporting_period: ReportingPeriod
          rate_effective_date: string
          rate_expiry_date: string | null
          is_active: boolean
          created_at: string
          created_by: string
        }
        Insert: {
          id?: string
          license_body: LicenseBody
          legal_name: string
          code: string
          contact_name: string
          contact_email: string
          default_royalty_rate: number
          minimum_royalty_cents?: number | null
          reporting_period: ReportingPeriod
          rate_effective_date: string
          rate_expiry_date?: string | null
          is_active?: boolean
          created_at?: string
          created_by: string
        }
        Update: {
          is_active?: boolean
          rate_expiry_date?: string | null
          contact_name?: string
          contact_email?: string
        }
        Relationships: []
      }

      // ── royalty_entries ───────────────────────────────────────────────────
      royalty_entries: {
        Row: {
          id: string
          license_holder_id: string
          license_body: LicenseBody
          license_holder_name: string
          reporting_period: ReportingPeriod
          period_start: string
          period_end: string
          ledger_entry_ids: string[]
          units_sold: number
          gross_sales_cents: number
          royalty_rate: number
          royalty_cents: number
          remittance_cents: number
          minimum_applied: boolean
          status: RoyaltyStatus
          licensor_reference_id: string | null
          submitted_at: string | null
          submitted_by: string | null
          paid_at: string | null
          payment_reference: string | null
          dispute_note: string | null
          resolution_note: string | null
          adjusted_remittance_cents: number | null
          created_at: string
          created_by: string
          updated_at: string
        }
        Insert: {
          id?: string
          license_holder_id: string
          license_body: LicenseBody
          license_holder_name: string
          reporting_period: ReportingPeriod
          period_start: string
          period_end: string
          ledger_entry_ids: string[]
          units_sold: number
          gross_sales_cents: number
          royalty_rate: number
          royalty_cents: number
          remittance_cents: number
          minimum_applied?: boolean
          status?: RoyaltyStatus
          licensor_reference_id?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          paid_at?: string | null
          payment_reference?: string | null
          dispute_note?: string | null
          resolution_note?: string | null
          adjusted_remittance_cents?: number | null
          created_at?: string
          created_by: string
          updated_at?: string
        }
        Update: {
          status?: RoyaltyStatus
          licensor_reference_id?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          paid_at?: string | null
          payment_reference?: string | null
          dispute_note?: string | null
          resolution_note?: string | null
          adjusted_remittance_cents?: number | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── consultant_profiles ───────────────────────────────────────────────
      consultant_profiles: {
        Row: {
          id: string
          auth_user_id: string
          status: ConsultantStatus
          legal_first_name: string
          legal_last_name: string
          display_name: string
          email: string
          phone: string | null
          tax_id: string | null
          tax_onboarding_complete: boolean
          /** ConsultantAddress stored as JSONB. Null until tax onboarding. */
          address: Json | null
          commission_tier: CommissionTier
          custom_commission_rate: number | null
          lifetime_gross_sales_cents: number
          lifetime_commissions_cents: number
          pending_payout_cents: number
          referred_by: string | null
          activated_at: string | null
          last_sale_at: string | null
          status_changed_at: string | null
          status_changed_by: string | null
          status_change_reason: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          auth_user_id: string
          status?: ConsultantStatus
          legal_first_name: string
          legal_last_name: string
          display_name: string
          email: string
          phone?: string | null
          tax_id?: string | null
          tax_onboarding_complete?: boolean
          address?: Json | null
          commission_tier?: CommissionTier
          custom_commission_rate?: number | null
          lifetime_gross_sales_cents?: number
          lifetime_commissions_cents?: number
          pending_payout_cents?: number
          referred_by?: string | null
          activated_at?: string | null
          last_sale_at?: string | null
          status_changed_at?: string | null
          status_changed_by?: string | null
          status_change_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          status?: ConsultantStatus
          display_name?: string
          email?: string
          phone?: string | null
          tax_id?: string | null
          tax_onboarding_complete?: boolean
          address?: Json | null
          commission_tier?: CommissionTier
          custom_commission_rate?: number | null
          lifetime_gross_sales_cents?: number
          lifetime_commissions_cents?: number
          pending_payout_cents?: number
          activated_at?: string | null
          last_sale_at?: string | null
          status_changed_at?: string | null
          status_changed_by?: string | null
          status_change_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── customer_profiles ─────────────────────────────────────────────────
      customer_profiles: {
        Row: {
          id: string
          auth_user_id: string
          email: string
          full_name: string | null
          phone: string | null
          default_shipping_address: Json | null
          marketing_email_opt_in: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          auth_user_id: string
          email: string
          full_name?: string | null
          phone?: string | null
          default_shipping_address?: Json | null
          marketing_email_opt_in?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          email?: string
          full_name?: string | null
          phone?: string | null
          default_shipping_address?: Json | null
          marketing_email_opt_in?: boolean
          updated_at?: string
        }
        Relationships: []
      }

      // ── commission_entries ────────────────────────────────────────────────
      commission_entries: {
        Row: {
          id: string
          consultant_id: string
          consultant_name: string
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          order_id: string
          retail_price_cents: number
          commission_tier: CommissionTier
          commission_rate: number
          commission_cents: number
          status: CommissionStatus
          hold_reason: string | null
          reversal_reason: string | null
          payout_batch_id: string | null
          approved_at: string | null
          approved_by: string | null
          paid_at: string | null
          reversed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          consultant_id: string
          consultant_name: string
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          order_id: string
          retail_price_cents: number
          commission_tier: CommissionTier
          commission_rate: number
          commission_cents: number
          status?: CommissionStatus
          hold_reason?: string | null
          reversal_reason?: string | null
          payout_batch_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          paid_at?: string | null
          reversed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          status?: CommissionStatus
          hold_reason?: string | null
          reversal_reason?: string | null
          payout_batch_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          paid_at?: string | null
          reversed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── orders ────────────────────────────────────────────────────────────
      orders: {
        Row: {
          id: string
          order_number: string
          status: OrderStatus
          channel: FulfillmentChannel
          customer_id: string | null
          customer_name: string
          customer_email: string
          consultant_id: string | null
          consultant_name: string | null
          /** ShippingAddress stored as JSONB. */
          shipping_address: Json
          payment_method: PaymentMethod
          payment_intent_id: string | null
          charge_id: string | null
          checkout_idempotency_key: string | null
          checkout_idempotency_expires_at: string | null
          checkout_response_cache: Json | null
          checkout_session_id: string | null
          subtotal_cents: number
          discount_cents: number
          shipping_cents: number
          tax_cents: number
          total_cents: number
          refunded_cents: number
          discount_code: string | null
          internal_notes: string | null
          created_at: string
          paid_at: string | null
          fulfilled_at: string | null
          closed_at: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          order_number: string
          status?: OrderStatus
          channel: FulfillmentChannel
          customer_id?: string | null
          customer_name: string
          customer_email: string
          consultant_id?: string | null
          consultant_name?: string | null
          shipping_address: Json
          payment_method: PaymentMethod
          payment_intent_id?: string | null
          charge_id?: string | null
          checkout_idempotency_key?: string | null
          checkout_idempotency_expires_at?: string | null
          checkout_response_cache?: Json | null
          checkout_session_id?: string | null
          subtotal_cents: number
          discount_cents?: number
          shipping_cents?: number
          tax_cents?: number
          total_cents: number
          refunded_cents?: number
          discount_code?: string | null
          internal_notes?: string | null
          created_at?: string
          paid_at?: string | null
          fulfilled_at?: string | null
          closed_at?: string | null
          updated_at?: string
        }
        Update: {
          status?: OrderStatus
          payment_intent_id?: string | null
          charge_id?: string | null
          checkout_idempotency_key?: string | null
          checkout_idempotency_expires_at?: string | null
          checkout_response_cache?: Json | null
          checkout_session_id?: string | null
          refunded_cents?: number
          internal_notes?: string | null
          paid_at?: string | null
          fulfilled_at?: string | null
          closed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── order_lines ───────────────────────────────────────────────────────
      order_lines: {
        Row: {
          id: string
          order_id: string
          line_number: number
          status: OrderLineStatus
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          license_body: LicenseBody
          royalty_rate: number
          royalty_cents: number
          retail_price_cents: number
          commission_tier: CommissionTier | null
          commission_rate: number | null
          commission_cents: number | null
          commission_entry_id: string | null
          carrier: string | null
          tracking_number: string | null
          shipped_at: string | null
          delivered_at: string | null
          returned_at: string | null
          return_reason: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          order_id: string
          line_number: number
          status?: OrderLineStatus
          unit_id: string
          serial_number: string
          sku: string
          product_name: string
          license_body: LicenseBody
          royalty_rate: number
          royalty_cents: number
          retail_price_cents: number
          commission_tier?: CommissionTier | null
          commission_rate?: number | null
          commission_cents?: number | null
          commission_entry_id?: string | null
          carrier?: string | null
          tracking_number?: string | null
          shipped_at?: string | null
          delivered_at?: string | null
          returned_at?: string | null
          return_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          status?: OrderLineStatus
          commission_entry_id?: string | null
          carrier?: string | null
          tracking_number?: string | null
          shipped_at?: string | null
          delivered_at?: string | null
          returned_at?: string | null
          return_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── fraud_flags ───────────────────────────────────────────────────────
      fraud_flags: {
        Row: {
          id: string
          unit_id: string
          serial_number: string
          sku: string
          source: FraudSignalSource
          severity: FraudFlagSeverity
          status: FraudFlagStatus
          unit_status_at_flag: UnitStatus
          auto_locked: boolean
          auto_lock_id: string | null
          related_order_id: string | null
          related_consultant_id: string | null
          reporting_licensor: 'CLC' | 'ARMY' | null
          signal_metadata: Json | null
          description: string
          raised_by: string
          assigned_to: string | null
          assigned_at: string | null
          investigation_notes: string | null
          escalation_reason: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          unit_id: string
          serial_number: string
          sku: string
          source: FraudSignalSource
          severity: FraudFlagSeverity
          status?: FraudFlagStatus
          unit_status_at_flag: UnitStatus
          auto_locked?: boolean
          auto_lock_id?: string | null
          related_order_id?: string | null
          related_consultant_id?: string | null
          reporting_licensor?: 'CLC' | 'ARMY' | null
          signal_metadata?: Json | null
          description: string
          raised_by: string
          assigned_to?: string | null
          assigned_at?: string | null
          investigation_notes?: string | null
          escalation_reason?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          status?: FraudFlagStatus
          auto_lock_id?: string | null
          assigned_to?: string | null
          assigned_at?: string | null
          investigation_notes?: string | null
          escalation_reason?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }

      // ── lock_records ──────────────────────────────────────────────────────
      lock_records: {
        Row: {
          id: string
          fraud_flag_id: string | null
          scope: LockScope
          target_id: string
          target_label: string
          lock_authority: LockAuthority
          status_before_lock: string
          is_active: boolean
          lock_reason: string
          licensor_reference_id: string | null
          locked_by: string
          locked_at: string
          release_reason: string | null
          release_authority: LockAuthority | null
          release_reference_id: string | null
          released_by: string | null
          released_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          fraud_flag_id?: string | null
          scope: LockScope
          target_id: string
          target_label: string
          lock_authority: LockAuthority
          status_before_lock: string
          is_active?: boolean
          lock_reason: string
          licensor_reference_id?: string | null
          locked_by: string
          locked_at?: string
          release_reason?: string | null
          release_authority?: LockAuthority | null
          release_reference_id?: string | null
          released_by?: string | null
          released_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          is_active?: boolean
          release_reason?: string | null
          release_authority?: LockAuthority | null
          released_by?: string | null
          released_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }

    }

    // ── Views ─────────────────────────────────────────────────────────────────
    // Defined in Phase 4 (schema + migrations).
    Views: Record<string, never>

    // ── Functions ─────────────────────────────────────────────────────────────
    // RPC functions defined in Phase 4.
    Functions: Record<string, never>

    // ── Enums ─────────────────────────────────────────────────────────────────
    // Each PostgreSQL enum must have the same value set as the TypeScript union.
    // Drift between these and @gtg/types unions is a schema migration error.
    Enums: {
      unit_status: UnitStatus
      license_body: LicenseBody
      ledger_action: LedgerAction
      reporting_period: ReportingPeriod
      royalty_status: RoyaltyStatus
      consultant_status: ConsultantStatus
      commission_tier: CommissionTier
      commission_status: CommissionStatus
      order_status: OrderStatus
      order_line_status: OrderLineStatus
      payment_method: PaymentMethod
      fulfillment_channel: FulfillmentChannel
      fraud_signal_source: FraudSignalSource
      fraud_flag_severity: FraudFlagSeverity
      fraud_flag_status: FraudFlagStatus
      lock_scope: LockScope
      lock_authority: LockAuthority
    }

    CompositeTypes: Record<string, never>
  }
}
