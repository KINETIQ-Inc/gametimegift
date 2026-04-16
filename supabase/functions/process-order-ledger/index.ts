/**
 * GTG Edge Function — process-order-ledger
 *
 * Architecture decomposition (Phase 4):
 * - validate-order
 * - reserve-inventory
 * - record-ledger
 * - compute-commission
 * - apply-royalty
 * - finalize-order
 *
 * External API response shape remains stable via buildProcessResponse().
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createUserClient } from '../_shared/supabase.ts'
import type { RequestBody, StepResult } from './contracts.ts'
import {
  buildFinalFailureResponse,
  buildFinalSuccessResponse,
} from './steps/finalize-order.ts'
import { runValidateOrderModule } from './steps/validate-order.ts'
import { runReserveInventoryModule } from './steps/reserve-inventory.ts'
import { runRecordLedgerModule } from './steps/record-ledger.ts'
import { runComputeCommissionModule } from './steps/compute-commission.ts'
import { runApplyRoyaltyModule } from './steps/apply-royalty.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const log = createLogger('process-order-ledger', req)
  log.info('Handler invoked', { method: req.method })

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    let body: RequestBody
    try {
      body = await req.json() as RequestBody
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!body.order_id || typeof body.order_id !== 'string') {
      return jsonError(req, 'Missing required field: order_id', 400)
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidPattern.test(body.order_id)) {
      return jsonError(req, 'order_id must be a valid UUID v4', 400)
    }

    const authHeader = req.headers.get('authorization') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const internalWebhookCall =
      body.internal_source === 'stripe-webhook' &&
      !!serviceRoleKey &&
      authHeader === `Bearer ${serviceRoleKey}`

    let authorized: { id: string; role: string }

    if (internalWebhookCall) {
      const serviceAccountId = Deno.env.get('GTG_SERVICE_ACCOUNT_ID')
      if (!serviceAccountId) {
        return jsonError(req, 'GTG_SERVICE_ACCOUNT_ID is required for internal invocation', 500)
      }
      authorized = { id: serviceAccountId, role: 'super_admin' }
      log.info('Authenticated internal invocation', { internal_source: body.internal_source })
    } else {
      const userClient = createUserClient(req)
      const { data: { user }, error: authError } = await userClient.auth.getUser()

      if (authError !== null || user === null) {
        log.warn('Authentication failed', { error: authError?.message })
        return unauthorized(req)
      }

      const roleCheck = verifyRole(user, ADMIN_ROLES, req)
      if (roleCheck.denied) {
        log.warn('Authorization failed', { userId: user.id })
        return roleCheck.denied
      }
      authorized = roleCheck.authorized
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    const steps: StepResult[] = []

    const validateOrder = await runValidateOrderModule(req, body, internalWebhookCall)
    steps.push(...validateOrder.steps)
    if (!validateOrder.ok) {
      return jsonResponse(
        req,
        buildFinalFailureResponse(body.order_id, steps, validateOrder.errors),
        validateOrder.status,
      )
    }

    const reserveInventory = await runReserveInventoryModule(req, body.order_id)
    steps.push(...reserveInventory.steps)
    if (!reserveInventory.ok) {
      return jsonResponse(
        req,
        buildFinalFailureResponse(body.order_id, steps, reserveInventory.errors),
        reserveInventory.status,
      )
    }

    const recordLedger = await runRecordLedgerModule(body.order_id, authorized.id)
    steps.push(...recordLedger.steps)
    if (!recordLedger.ok) {
      return jsonResponse(
        req,
        buildFinalFailureResponse(body.order_id, steps, recordLedger.errors),
        recordLedger.status,
      )
    }

    const computeCommission = await runComputeCommissionModule(body.order_id)
    steps.push(...computeCommission.steps)
    if (!computeCommission.ok) {
      return jsonResponse(
        req,
        buildFinalFailureResponse(body.order_id, steps, computeCommission.errors),
        computeCommission.status,
      )
    }

    const applyRoyalty = await runApplyRoyaltyModule(
      body.order_id,
      authorized.id,
      recordLedger.inventory_ledger_entry_ids,
    )
    steps.push(...applyRoyalty.steps)
    if (!applyRoyalty.ok) {
      return jsonResponse(
        req,
        buildFinalFailureResponse(body.order_id, steps, applyRoyalty.errors),
        applyRoyalty.status,
      )
    }

    return jsonResponse(req, buildFinalSuccessResponse(body.order_id, steps))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
