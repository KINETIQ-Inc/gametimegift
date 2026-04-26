import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gtg/supabase', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '@gtg/supabase'
import {
  assignProductLicense,
  createProduct,
  listProducts,
  updateProduct,
} from '../products'
import {
  getCommissionSummary,
  getConsultantPendingPayouts,
  getConsultantCommissionEarned,
  getConsultantUnitsSold,
  viewConsultantPerformance,
} from '../commissions'
import { getReferralLink } from '../referrals'
import { resolveConsultantCode } from '../consultant'
import {
  exportRoyaltyCsv,
  getArmyRoyaltyReport,
  getClcRoyaltyReport,
  getRoyaltySummary,
} from '../royalties'
import { createCheckoutSession, createOrder, processOrderLedger, submitOrder } from '../orders'
import {
  bulkUploadSerializedUnits,
  getUnitStatus,
  verifyHologramSerial,
  viewUnitHistory,
  viewUnitStatus,
} from '../inventory'
import {
  createFraudFlag,
  getFraudWarning,
  resolveFraudFlag,
  viewFraudEvents,
} from '../fraud'

type InvokeReturn = {
  data: unknown
  error: { message: string } | null
}

const invokeMock = vi.fn<(...args: unknown[]) => Promise<InvokeReturn>>()
const getSupabaseClientMock = vi.mocked(getSupabaseClient)

const UUID = '123e4567-e89b-42d3-a456-426614174000'

beforeEach(() => {
  invokeMock.mockReset()
  getSupabaseClientMock.mockReturnValue({
    functions: {
      invoke: invokeMock,
    },
  } as unknown as ReturnType<typeof getSupabaseClient>)
})

describe('API wrapper invoked edge functions', () => {
  it('listProducts invokes list-products with body', async () => {
    invokeMock.mockResolvedValue({
      data: { data: { products: [], total: 0, limit: 10, offset: 0 } },
      error: null,
    })

    await listProducts({ search: 'jersey', limit: 10, offset: 0 })

    expect(invokeMock).toHaveBeenCalledWith('list-products', {
      body: { search: 'jersey', limit: 10, offset: 0 },
    })
  })

  it('createProduct invokes create-product', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          id: UUID,
          sku: 'APP-SKU',
          name: 'Name',
          description: null,
          license_body: 'CLC',
          royalty_rate: 0.14,
          cost_cents: 1000,
          retail_price_cents: 2500,
          is_active: true,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          created_by: UUID,
        },
      },
      error: null,
    })

    await createProduct({
      sku: 'APP-SKU',
      name: 'Name',
      license_body: 'CLC',
      cost_cents: 1000,
      retail_price_cents: 2500,
    })

    expect(invokeMock).toHaveBeenCalledWith(
      'create-product',
      expect.objectContaining({ body: expect.objectContaining({ sku: 'APP-SKU' }) }),
    )
  })

  it('updateProduct invokes edit-product', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          id: UUID,
          sku: 'APP-SKU',
          name: 'Updated',
          description: null,
          license_body: 'CLC',
          royalty_rate: 0.14,
          cost_cents: 1000,
          retail_price_cents: 2500,
          is_active: true,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          created_by: UUID,
        },
      },
      error: null,
    })

    await updateProduct({ product_id: UUID, name: 'Updated' })

    expect(invokeMock).toHaveBeenCalledWith('edit-product', {
      body: { product_id: UUID, name: 'Updated' },
    })
  })

  it('assignProductLicense invokes assign-product-license', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          product_id: UUID,
          sku: 'APP-SKU',
          license_body: 'CLC',
          royalty_rate: 0.14,
          effective_rate: 0.14,
          license_holder: null,
        },
      },
      error: null,
    })

    await assignProductLicense({ product_id: UUID, license_body: 'CLC' })

    expect(invokeMock).toHaveBeenCalledWith('assign-product-license', {
      body: { product_id: UUID, license_body: 'CLC' },
    })
  })

  it('getCommissionSummary invokes commission-summary', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          period: { start: null, end: null },
          totals: { units_sold: 0, gross_sales_cents: 0, commission_cents: 0 },
          consultant_totals: {
            lifetime_gross_sales_cents: 0,
            lifetime_commissions_cents: 0,
            pending_payout_cents: 0,
          },
          by_status: {
            earned: { count: 0, commission_cents: 0 },
            held: { count: 0, commission_cents: 0 },
            approved: { count: 0, commission_cents: 0 },
            paid: { count: 0, commission_cents: 0 },
            reversed: { count: 0, commission_cents: 0 },
            voided: { count: 0, commission_cents: 0 },
          },
          recent_entries: [],
          recent_entry_count: 0,
        },
      },
      error: null,
    })

    await getCommissionSummary({ consultantId: UUID, fromDate: '2026-01-01', toDate: '2026-01-31' })

    expect(invokeMock).toHaveBeenCalledWith('commission-summary', {
      body: {
        consultant_id: UUID,
        from_date: '2026-01-01',
        to_date: '2026-01-31',
      },
    })
  })

  it('getConsultantUnitsSold invokes get-consultant-units-sold', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          period: { start: '2026-01-01', end: '2026-01-31' },
          period_summary: {
            orders_count: 0,
            units_sold: 0,
            gross_sales_cents: 0,
            commission_cents: 0,
          },
          lifetime: {
            gross_sales_cents: 0,
            commissions_cents: 0,
            pending_payout_cents: 0,
          },
          recent_orders: [],
        },
      },
      error: null,
    })

    await getConsultantUnitsSold({
      consultantId: UUID,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    })

    expect(invokeMock).toHaveBeenCalledWith('get-consultant-units-sold', {
      body: {
        consultant_id: UUID,
        period_start: '2026-01-01',
        period_end: '2026-01-31',
      },
    })
  })

  it('getConsultantCommissionEarned invokes get-consultant-commission-earned', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          period: { start: '2026-01-01', end: '2026-01-31' },
          period_summary: {
            entries_count: 0,
            earned_cents: 0,
            paid_cents: 0,
            voided_cents: 0,
            net_cents: 0,
          },
          lifetime: {
            gross_sales_cents: 0,
            commissions_cents: 0,
            pending_payout_cents: 0,
          },
          recent_entries: [],
        },
      },
      error: null,
    })

    await getConsultantCommissionEarned({
      consultantId: UUID,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    })

    expect(invokeMock).toHaveBeenCalledWith('get-consultant-commission-earned', {
      body: {
        consultant_id: UUID,
        period_start: '2026-01-01',
        period_end: '2026-01-31',
      },
    })
  })

  it('getConsultantPendingPayouts invokes get-consultant-pending-payouts', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          pending_payout_cents: 0,
          entries_count: 0,
          entries: [],
        },
      },
      error: null,
    })

    await getConsultantPendingPayouts({ consultantId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('get-consultant-pending-payouts', {
      body: { consultant_id: UUID },
    })
  })

  it('viewConsultantPerformance invokes view-consultant-performance', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant: {},
          summary: {
            year_month: '2026-01',
            total_entries: 0,
            earned_count: 0,
            earned_cents: 0,
            held_count: 0,
            held_cents: 0,
            approved_count: 0,
            approved_cents: 0,
            paid_count: 0,
            paid_cents: 0,
            reversed_count: 0,
            reversed_cents: 0,
            voided_count: 0,
            voided_cents: 0,
            net_earned_cents: 0,
          },
          commissions: [],
        },
      },
      error: null,
    })

    await viewConsultantPerformance({ consultantId: UUID, yearMonth: '2026-01' })

    expect(invokeMock).toHaveBeenCalledWith('view-consultant-performance', {
      body: {
        consultant_id: UUID,
        year_month: '2026-01',
      },
    })
  })

  it('getReferralLink invokes get-referral-link', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          referral_code: 'ABC123',
          referral_url: 'https://example.com',
          share_text: 'share',
          lifetime_gross_sales_cents: 0,
          lifetime_commissions_cents: 0,
          total_referred_orders: 0,
        },
      },
      error: null,
    })

    await getReferralLink({ consultantId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('get-referral-link', {
      body: { consultant_id: UUID },
    })
  })

  it('resolveConsultantCode invokes resolve-consultant-code', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          consultant_id: UUID,
          display_name: 'Consultant',
          referral_code: 'GTG-TEST1',
        },
      },
      error: null,
    })

    await resolveConsultantCode('gtg-test1')

    expect(invokeMock).toHaveBeenCalledWith('resolve-consultant-code', {
      body: {
        referral_code: 'GTG-TEST1',
      },
    })
  })

  it('getRoyaltySummary invokes calculate-royalties-owed', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          year_month: '2026-01',
          period_start: '2026-01-01',
          period_end: '2026-01-31',
          royalties: [],
        },
      },
      error: null,
    })

    await getRoyaltySummary('2026-01')

    expect(invokeMock).toHaveBeenCalledWith('calculate-royalties-owed', {
      body: { year_month: '2026-01' },
    })
  })

  it('getClcRoyaltyReport invokes generate-clc-report', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          report: {
            generated_at: '2026-03-31T00:00:00Z',
            license_body: 'CLC',
            period_start: '2026-01-01',
            period_end: '2026-03-31',
            reporting_period: 'quarterly',
          },
          licensor: {
            id: UUID,
            legal_name: 'CLC',
            code: 'CLC-001',
            contact_name: 'Team',
            contact_email: 'clc@example.com',
            default_royalty_rate: 0.14,
            minimum_royalty_cents: 50000,
            reporting_period: 'quarterly',
            rate_effective_date: '2026-01-01',
            rate_expiry_date: null,
          },
          royalty_entry: {
            id: UUID,
            units_sold: 1,
            gross_sales_cents: 4999,
            royalty_rate: 0.14,
            royalty_cents: 700,
            remittance_cents: 700,
            minimum_applied: false,
            status: 'calculated',
            licensor_reference_id: null,
            submitted_at: null,
            submitted_by: null,
            paid_at: null,
            payment_reference: null,
            dispute_note: null,
            resolution_note: null,
            adjusted_remittance_cents: null,
            created_at: '2026-03-31T00:00:00Z',
            updated_at: '2026-03-31T00:00:00Z',
          },
          unit_sales: [],
          active_locks: [],
        },
      },
      error: null,
    })

    await getClcRoyaltyReport('2026-01')

    expect(invokeMock).toHaveBeenCalledWith('generate-clc-report', {
      body: { year_month: '2026-01' },
    })
  })

  it('getArmyRoyaltyReport invokes generate-army-report', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          report: {
            generated_at: '2026-03-31T00:00:00Z',
            license_body: 'ARMY',
            period_start: '2026-03-01',
            period_end: '2026-03-31',
            reporting_period: 'monthly',
          },
          licensor: {
            id: UUID,
            legal_name: 'ARMY',
            code: 'ARMY-001',
            contact_name: 'Team',
            contact_email: 'army@example.com',
            default_royalty_rate: 0.17,
            minimum_royalty_cents: 25000,
            reporting_period: 'monthly',
            rate_effective_date: '2026-01-01',
            rate_expiry_date: null,
          },
          royalty_entry: {
            id: UUID,
            units_sold: 1,
            gross_sales_cents: 4999,
            royalty_rate: 0.17,
            royalty_cents: 850,
            remittance_cents: 850,
            minimum_applied: false,
            status: 'submitted',
            licensor_reference_id: 'ARMY-1',
            submitted_at: '2026-03-31T00:00:00Z',
            submitted_by: UUID,
            paid_at: null,
            payment_reference: null,
            dispute_note: null,
            resolution_note: null,
            adjusted_remittance_cents: null,
            created_at: '2026-03-31T00:00:00Z',
            updated_at: '2026-03-31T00:00:00Z',
          },
          unit_sales: [],
          active_locks: [],
        },
      },
      error: null,
    })

    await getArmyRoyaltyReport('2026-03')

    expect(invokeMock).toHaveBeenCalledWith('generate-army-report', {
      body: { year_month: '2026-03' },
    })
  })

  it('exportRoyaltyCsv invokes export-royalty-csv with accept header', async () => {
    invokeMock.mockResolvedValue({
      data: 'Report,GTG Royalty Report',
      error: null,
    })

    await exportRoyaltyCsv({ licenseBody: 'CLC', yearMonth: '2026-01' })

    expect(invokeMock).toHaveBeenCalledWith('export-royalty-csv', {
      body: {
        license_body: 'CLC',
        year_month: '2026-01',
      },
      headers: {
        Accept: 'text/csv',
      },
    })
  })

  it('submitOrder invokes process-order-ledger', async () => {
    invokeMock.mockResolvedValue({
      data: {
        phase: '5A-5C',
        pipeline: 'processOrderLedger',
        order_id: UUID,
        success: true,
        status: 'completed',
        completed_steps: 9,
        total_steps: 9,
        steps: [],
        errors: [],
      },
      error: null,
    })

    await submitOrder({ orderId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('process-order-ledger', {
      body: { order_id: UUID },
    })
  })

  it('processOrderLedger invokes process-order-ledger', async () => {
    invokeMock.mockResolvedValue({
      data: {
        phase: '5A-5C',
        pipeline: 'processOrderLedger',
        order_id: UUID,
        success: true,
        status: 'completed',
        completed_steps: 9,
        total_steps: 9,
        steps: [],
        errors: [],
      },
      error: null,
    })

    await processOrderLedger({ orderId: UUID })

    expect(invokeMock).toHaveBeenCalledWith('process-order-ledger', {
      body: { order_id: UUID },
    })
  })

  it('createCheckoutSession invokes create-checkout-session', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          order_id: UUID,
          order_number: 'GTG-20260403-000001',
          session_id: 'sess_1',
          session_url: 'https://checkout.stripe.com',
          unit_id: UUID,
          serial_number: 'SER-1',
          product_id: UUID,
          sku: 'APP-SKU',
          product_name: 'Name',
          channel: 'storefront_direct',
        },
      },
      error: null,
    })

    await createCheckoutSession({
      productId: UUID,
      customerName: 'John Doe',
      customerEmail: 'JOHN@EXAMPLE.COM',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      idempotencyKey: 'gtg-checkout-test-key-0001',
      consultantId: UUID,
    })

    expect(invokeMock).toHaveBeenCalledWith('create-checkout-session', {
      body: {
        product_id: UUID,
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
        idempotency_key: 'gtg-checkout-test-key-0001',
        consultant_id: UUID,
      },
    })
  })

  it('createOrder invokes create-order edge function', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          order_id: UUID,
          order_number: 'GTG-20260403-000001',
          payment_intent_id: 'pi_test_001',
          client_secret: 'pi_test_001_secret',
          total_cents: 9999,
          unit_id: UUID,
          serial_number: 'SER-1',
          product_id: UUID,
          sku: 'APP-SKU',
          product_name: 'Name',
          channel: 'storefront_direct',
        },
      },
      error: null,
    })

    await createOrder({
      productId: UUID,
      customerName: 'John Doe',
      customerEmail: 'JOHN@EXAMPLE.COM',
      idempotencyKey: 'gtg-checkout-test-key-0002',
    })

    expect(invokeMock).toHaveBeenCalledWith('create-order', {
      body: {
        product_id: UUID,
        quantity: 1,
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        idempotency_key: 'gtg-checkout-test-key-0002',
      },
    })
  })

  it('bulkUploadSerializedUnits invokes bulk-upload-units', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          batch_id: UUID,
          batch_number: 'BATCH-1',
          product_id: UUID,
          sku: 'APP-SKU',
          license_body: 'CLC',
          royalty_rate_stamped: 0.14,
          expected_unit_count: 1,
          submitted_count: 1,
          received_count: 1,
          conflict_count: 0,
          conflict_serials: [],
        },
      },
      error: null,
    })

    const csvBlob = new Blob(['serial_number\nSER-1'])
    Object.assign(csvBlob, { name: 'units.csv' })

    await bulkUploadSerializedUnits({
      productId: UUID,
      batchNumber: 'BATCH-1',
      expectedUnitCount: 1,
      csvFile: csvBlob,
      purchaseOrderNumber: 'PO-1',
      notes: 'test',
    })

    const [fnName, payload] = invokeMock.mock.calls[0] as [string, { body: unknown }]
    expect(fnName).toBe('bulk-upload-units')
    expect(payload.body).toBeInstanceOf(FormData)
  })

  it('verifyHologramSerial invokes verify-serial', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          verified: true,
          serial_number: 'SER-1',
          sku: 'APP-SKU',
          product_name: 'Name',
          license_body: 'CLC',
          hologram: null,
          verification_status: 'authentic',
          received_at: '2026-01-01T00:00:00Z',
          sold_at: null,
        },
      },
      error: null,
    })

    await verifyHologramSerial('SER-1')

    expect(invokeMock).toHaveBeenCalledWith('verify-serial', {
      body: { serial_number: 'SER-1' },
    })
  })

  it('viewUnitStatus invokes view-unit-status', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          units: [],
          total: 0,
          limit: 50,
          offset: 0,
        },
      },
      error: null,
    })

    await viewUnitStatus({ status: 'available', limit: 50, offset: 0 })

    expect(invokeMock).toHaveBeenCalledWith('view-unit-status', {
      body: { status: 'available', limit: 50, offset: 0 },
    })
  })

  it('viewUnitHistory invokes view-unit-history', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          unit: {},
          ledger: [],
          fraud_flags: [],
          lock_records: [],
          commission: null,
        },
      },
      error: null,
    })

    await viewUnitHistory({ unit_id: UUID })

    expect(invokeMock).toHaveBeenCalledWith('view-unit-history', {
      body: { unit_id: UUID },
    })
  })

  it('getUnitStatus invokes get-unit-status', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          unit_id: UUID,
          serial_number: 'SER-1',
          sku: 'APP-SKU',
          product_id: UUID,
          product_name: 'Name',
          product_description: null,
          license_body: 'CLC',
          royalty_rate: 0.14,
          status: 'sold',
          hologram: null,
          order_id: UUID,
          received_at: '2026-01-01T00:00:00Z',
          sold_at: null,
          returned_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      error: null,
    })

    await getUnitStatus({ serial_number: 'SER-1' })

    expect(invokeMock).toHaveBeenCalledWith('get-unit-status', {
      body: { serial_number: 'SER-1' },
    })
  })

  it('createFraudFlag invokes create-fraud-flag', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          fraud_flag_id: UUID,
          unit_id: UUID,
          source: 'admin_manual',
          severity: 'high',
          lock_record_id: UUID,
          auto_locked: true,
        },
      },
      error: null,
    })

    await createFraudFlag({
      unit_id: UUID,
      source: 'admin_manual',
      severity: 'high',
      description: 'Fraud signal captured.',
    })

    expect(invokeMock).toHaveBeenCalledWith('create-fraud-flag', {
      body: {
        unit_id: UUID,
        source: 'admin_manual',
        severity: 'high',
        description: 'Fraud signal captured.',
        related_order_id: undefined,
        related_consultant_id: undefined,
        reporting_licensor: undefined,
        signal_metadata: undefined,
      },
    })
  })

  it('viewFraudEvents invokes view-fraud-events', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          flags: [],
          total: 0,
          limit: 50,
          offset: 0,
        },
      },
      error: null,
    })

    await viewFraudEvents({
      status: ['open', 'under_review'],
      severity: ['high', 'critical'],
      limit: 50,
      offset: 0,
    })

    expect(invokeMock).toHaveBeenCalledWith('view-fraud-events', {
      body: {
        status: ['open', 'under_review'],
        severity: ['high', 'critical'],
        limit: 50,
        offset: 0,
      },
    })
  })

  it('resolveFraudFlag invokes resolve-fraud-flag', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          fraud_flag_id: UUID,
          unit_id: UUID,
          serial_number: 'SER-1',
          resolution: 'confirmed',
          status: 'confirmed',
          resolution_note: 'confirmed',
          resolved_at: '2026-03-01T00:00:00.000Z',
          resolved_by: UUID,
          locks_released: [],
        },
      },
      error: null,
    })

    await resolveFraudFlag({
      fraud_flag_id: UUID,
      resolution: 'confirmed',
      resolution_note: 'confirmed',
    })

    expect(invokeMock).toHaveBeenCalledWith('resolve-fraud-flag', {
      body: {
        fraud_flag_id: UUID,
        resolution: 'confirmed',
        resolution_note: 'confirmed',
        release_reference_id: undefined,
      },
    })
  })

  it('getFraudWarning invokes get-fraud-warning', async () => {
    invokeMock.mockResolvedValue({
      data: {
        data: {
          serial_number: 'SER-1',
          has_warning: false,
          warning_level: 'none',
          warning_code: 'none',
          headline: null,
          guidance: null,
          flagged_at: null,
        },
      },
      error: null,
    })

    await getFraudWarning('SER-1')

    expect(invokeMock).toHaveBeenCalledWith('get-fraud-warning', {
      body: { serial_number: 'SER-1' },
    })
  })
})
