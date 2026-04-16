/**
 * Public response contract and async state types for @gtg/api consumers.
 *
 * ─── BOUNDARY RULES ──────────────────────────────────────────────────────────
 *
 * 1. Single import surface
 *    App code imports from '@gtg/api' only. No app may import from
 *    '@gtg/supabase', '@gtg/domain', or any other internal package directly.
 *
 * 2. No direct backend/data-provider access from UI
 *    Apps do not call Supabase, REST endpoints, or any data provider directly.
 *    All reads and writes go through @gtg/api functions. This rule applies
 *    regardless of which backend or data provider is in use.
 *
 * 3. App-layer auth/session work goes through public auth wrappers
 *    exported by '@gtg/api'. Apps do not talk to the backend client directly.
 *
 * 4. No UI-side financial calculations or bypass paths
 *    All financial amounts (commissions, royalties, order totals) are
 *    calculated server-side. App code displays what the API returns;
 *    it never computes financial values independently.
 *
 * ─── MODULE OWNERSHIP ────────────────────────────────────────────────────────
 *
 *   orders      → submitOrder, createCheckoutSession, fetchOrderById
 *   consultant  → getConsultantProfile, updateConsultantProfile
 *   admin       → createConsultant, listConsultants, approveConsultant,
 *                 suspendConsultant, terminateConsultant, reactivateConsultant,
 *                 assignConsultantCommissionRate, approvePayouts
 *   campaign    → listCampaigns, validateDiscountCode, createCampaign,
 *                 updateCampaign
 *   commissions → getCommissionSummary, getConsultantUnitsSold,
 *                 getConsultantCommissionEarned, getConsultantPendingPayouts,
 *                 viewConsultantPerformance, getConsultantDashboard
 *   royalties   → getRoyaltySummary, getClcRoyaltyReport, getArmyRoyaltyReport,
 *                 exportRoyaltyCsv
 *   inventory   → getInventoryStatus, getSerializedUnit, bulkUploadSerializedUnits,
 *                 validateBatch, verifyHologramSerial, viewUnitStatus,
 *                 viewUnitHistory, getUnitStatus
 *   fraud       → createFraudFlag, viewFraudEvents, escalateFraudFlag,
 *                 resolveFraudFlag, getFraudWarning
 *   products    → listProducts, createProduct, updateProduct, deactivateProduct,
 *                 assignProductLicense
 *   referrals   → getReferralLink
 *
 * @example
 * ```ts
 * import { ApiRequestError, ApiState, API_IDLE, API_PENDING, submitOrder } from '@gtg/api'
 *
 * const [state, setState] = useState<ApiState<SubmitOrderResult>>(API_IDLE)
 *
 * async function handleSubmit(orderId: string) {
 *   setState(API_PENDING)
 *   try {
 *     const data = await submitOrder({ orderId })
 *     setState({ status: 'success', data })
 *   } catch (err) {
 *     const message = err instanceof ApiRequestError ? err.message : 'Unknown error'
 *     setState({ status: 'error', message })
 *   }
 * }
 * ```
 */

// ─── Async State Variants ─────────────────────────────────────────────────────

/** No call has been made yet. */
export type ApiIdle = { readonly status: 'idle' }

/** A call is in-flight. */
export type ApiPending = { readonly status: 'pending' }

/** The call completed successfully. */
export type ApiSuccess<T> = { readonly status: 'success'; readonly data: T }

/** The call threw an error. `message` is the Error.message string. */
export type ApiFailure = { readonly status: 'error'; readonly message: string }

// ─── Discriminated Union ──────────────────────────────────────────────────────

/**
 * Discriminated union representing the full async lifecycle of an API call.
 *
 * Narrow by `state.status` to access `state.data` (success) or
 * `state.message` (error).
 */
export type ApiState<T> = ApiIdle | ApiPending | ApiSuccess<T> | ApiFailure

// ─── Sentinels ────────────────────────────────────────────────────────────────

/** Stable reference for the initial idle state — safe to use as a default value. */
export const API_IDLE: ApiIdle = { status: 'idle' }

/** Stable reference for the pending state — avoids allocating a new object per call. */
export const API_PENDING: ApiPending = { status: 'pending' }

// ─── Response Envelopes ───────────────────────────────────────────────────────

/**
 * Explicit success envelope for use when app code needs to wrap an API result
 * in a serializable success/error discriminated union — for example when passing
 * results through a message bus, caching layer, or server action.
 *
 * NOT the same as ApiState<T>, which tracks async lifecycle (idle/pending/success/error).
 * Use ApiEnvelope<T> when you need only the resolved success-or-failure snapshot.
 *
 * All @gtg/api functions throw ApiRequestError on failure rather than returning
 * ApiErrorEnvelope. Use wrapApiCall() to convert the throw-based contract into
 * this return-based envelope when the calling context requires it.
 *
 * @example
 * ```ts
 * import { wrapApiCall, ApiEnvelope, submitOrder } from '@gtg/api'
 *
 * // In a React Server Action:
 * async function submitOrderAction(orderId: string): Promise<ApiEnvelope<SubmitOrderResult>> {
 *   return wrapApiCall(() => submitOrder({ orderId }))
 * }
 * ```
 */

/** A successful API call result. Discriminated by `success: true`. */
export type ApiSuccessEnvelope<T> = {
  readonly success: true
  readonly data: T
}

/** A failed API call result. Discriminated by `success: false`. */
export type ApiErrorEnvelope = {
  readonly success: false
  /** Stable error code — safe to switch on. Maps to ApiErrorCode from error.ts. */
  readonly code: string
  /** Human-readable description — for logging and display. */
  readonly message: string
}

/**
 * Discriminated union of a resolved API call — either success with data
 * or failure with a code and message.
 *
 * Narrow by `envelope.success`:
 *   true  → envelope.data is typed as T
 *   false → envelope.code and envelope.message describe the failure
 */
export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope

// ─── wrapApiCall ──────────────────────────────────────────────────────────────

/**
 * Convert an @gtg/api function call (throw-based) to a return-based ApiEnvelope<T>.
 *
 * Use this adapter when the calling context cannot propagate exceptions —
 * for example React Server Actions, tRPC procedures, or message handlers.
 *
 * @example
 * ```ts
 * const result = await wrapApiCall(() => submitOrder({ orderId }))
 * if (result.success) {
 *   console.log(result.data.order_id)
 * } else {
 *   console.error(result.code, result.message)
 * }
 * ```
 */
export async function wrapApiCall<T>(fn: () => Promise<T>): Promise<ApiEnvelope<T>> {
  try {
    const data = await fn()
    return { success: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code =
      err != null &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN_ERROR'
    return { success: false, code, message }
  }
}
