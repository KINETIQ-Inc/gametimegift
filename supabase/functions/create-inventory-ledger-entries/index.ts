/**
 * GTG Edge Function — create-inventory-ledger-entries
 *
 * Administrative endpoint for writing inventory ledger entries that accompany
 * lifecycle transitions on serialized units.
 *
 * This function handles the 'voided' action — the only administrative unit
 * disposition that does not belong to the order-processing flow (reserved,
 * sold, returned) or the fraud flow (fraud_locked, fraud_released, which are
 * handled by lock-units and future release-units). Additional actions
 * (received, hologram_applied) will be added as dedicated steps are built.
 *
 * Each entry is processed via a dedicated DB function that executes atomically:
 *
 *   voided → void_unit()
 *     SELECT FOR UPDATE → status check → UPDATE serialized_units
 *     → INSERT inventory_ledger_entries via append_ledger_entry()
 *
 * All three writes happen in a single transaction per unit. A failure on one
 * unit does not roll back others; the caller receives a per-entry result.
 *
 * Authorization: ADMIN_ROLES only. Voiding is an irreversible, compliance-
 * critical action. The ledger entry and status change are permanent.
 *
 * ─── Request ─────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/create-inventory-ledger-entries
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: application/json
 *
 *   {
 *     "entries": [
 *       {
 *         "unit_id":  "uuid",           // required
 *         "action":   "voided",         // required; currently only 'voided' supported
 *         "reason":   "string",         // required for voided
 *         "metadata": { ... }           // optional; arbitrary key-value context
 *       }
 *     ]
 *   }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   200 {
 *     "data": {
 *       "summary": {
 *         "total": 3,
 *         "succeeded": 2,
 *         "failed": 1,
 *         "all_succeeded": false
 *       },
 *       "results": [
 *         {
 *           "unit_id": "...",
 *           "action": "voided",
 *           "succeeded": true,
 *           "ledger_entry_id": "..."
 *         },
 *         {
 *           "unit_id": "...",
 *           "action": "voided",
 *           "succeeded": false,
 *           "error": "[GTG] void_unit: unit 'GTG-XYZ' is already voided."
 *         }
 *       ]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Bad request (missing / invalid fields, unsupported action)
 *   401  Unauthenticated
 *   403  Forbidden (not an admin)
 *   500  Internal server error
 *
 * ─── Local testing ────────────────────────────────────────────────────────────
 *
 *   supabase start
 *   supabase functions serve create-inventory-ledger-entries \
 *     --env-file supabase/.env.local
 *
 *   curl -i --location --request POST \
 *     'http://127.0.0.1:54321/functions/v1/create-inventory-ledger-entries' \
 *     --header 'Authorization: Bearer <admin-jwt>' \
 *     --header 'Content-Type: application/json' \
 *     --data '{
 *       "entries": [{
 *         "unit_id": "<uuid>",
 *         "action": "voided",
 *         "reason": "Physical damage during warehouse inspection"
 *       }]
 *     }'
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 50

/**
 * Actions supported by this endpoint.
 *
 * 'voided' — irreversible write-off of a damaged, lost, or confirmed-counterfeit unit.
 *
 * Future additions (when their dedicated infrastructure is ready):
 *   'received'        — initial unit intake, handled with receive-units step
 *   'hologram_applied'— hologram affixing, handled with apply-hologram step
 */
const SUPPORTED_ACTIONS = new Set(['voided'])

// ─── Types ────────────────────────────────────────────────────────────────────

interface EntryRequest {
  unit_id: string
  action: string
  reason?: string | null
  metadata?: Record<string, string | number | boolean> | null
}

interface EntryResult {
  unit_id: string
  action: string
  succeeded: boolean
  ledger_entry_id?: string
  error?: string
}

interface ResultSummary {
  total: number
  succeeded: number
  failed: number
  all_succeeded: boolean
}

interface ResponsePayload {
  summary: ResultSummary
  results: EntryResult[]
}

/** Shape returned by the void_unit() DB function (RETURNS TABLE). */
interface VoidUnitRpcRow {
  ledger_entry_id: string
}

// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * Validate a single entry request at the application layer.
 * Returns an error string if invalid, null if valid.
 * Per-action requirements are checked here; DB constraints are the backstop.
 */
function validateEntry(
  entry: EntryRequest,
  uuidPattern: RegExp,
  index: number,
): string | null {
  if (!entry.unit_id || typeof entry.unit_id !== 'string' || !uuidPattern.test(entry.unit_id)) {
    return `entries[${index}].unit_id must be a valid UUID v4`
  }

  if (!entry.action || !SUPPORTED_ACTIONS.has(entry.action)) {
    const supported = [...SUPPORTED_ACTIONS].join(', ')
    return `entries[${index}].action must be one of: ${supported} (got "${entry.action ?? ''}")`
  }

  // Per-action field requirements.
  if (entry.action === 'voided') {
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      return `entries[${index}].reason is required for action 'voided' and must be a non-empty string`
    }
  }

  if (entry.metadata !== undefined && entry.metadata !== null) {
    if (typeof entry.metadata !== 'object' || Array.isArray(entry.metadata)) {
      return `entries[${index}].metadata must be a plain object if provided`
    }
    for (const [key, val] of Object.entries(entry.metadata)) {
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
        return `entries[${index}].metadata["${key}"] must be a string, number, or boolean`
      }
    }
  }

  return null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ────────────────────────────────────────────────────────

  const log = createLogger('create-inventory-ledger-entries', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ──────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ─────────────────────────────────────────────────────

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse and validate request body ───────────────────────────────

    let body: { entries: EntryRequest[] }
    try {
      body = await req.json() as { entries: EntryRequest[] }
    } catch {
      return jsonError(req, 'Request body must be valid JSON', 400)
    }

    if (!Array.isArray(body.entries)) {
      return jsonError(req, 'entries must be an array', 400)
    }
    if (body.entries.length === 0) {
      return jsonError(req, 'entries must contain at least one item', 400)
    }
    if (body.entries.length > MAX_ENTRIES) {
      return jsonError(
        req,
        `entries may contain at most ${MAX_ENTRIES} items per request (received ${body.entries.length})`,
        400,
      )
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    for (let i = 0; i < body.entries.length; i++) {
      const err = validateEntry(body.entries[i]!, uuidPattern, i)
      if (err !== null) {
        return jsonError(req, err, 400)
      }
    }

    authedLog.info('Processing entries', { count: body.entries.length })

    // ── Step 6: Process each entry via its DB function ────────────────────────
    // Each action routes to a dedicated DB function that handles the full
    // transaction atomically (row lock → status update → ledger insert).
    // Sequential execution is intentional — preserves ordering in the audit
    // log and avoids connection pool pressure for large batches.

    const admin = createAdminClient()
    const results: EntryResult[] = []

    for (const entry of body.entries) {
      // Currently only 'voided' is supported. The if-else chain is intentionally
      // written for easy extension — add a new branch when the next action type
      // and its DB function are ready.

      if (entry.action === 'voided') {
        const { data, error } = await admin.rpc('void_unit', {
          p_unit_id:      entry.unit_id,
          p_performed_by: authorized.id,
          p_reason:       entry.reason!.trim(),
          p_metadata:     entry.metadata ? JSON.stringify(entry.metadata) : null,
        })

        if (error !== null) {
          const raw = error.message ?? 'Unknown DB error'
          const match = raw.match(/\[GTG\][^.]+\./)
          const userMessage = match ? match[0] : raw

          authedLog.warn('void_unit failed', { unit_id: entry.unit_id, error: raw })
          results.push({
            unit_id: entry.unit_id,
            action: entry.action,
            succeeded: false,
            error: userMessage,
          })
          continue
        }

        const row = (data as VoidUnitRpcRow[] | null)?.[0]

        if (row === undefined || row === null) {
          authedLog.error('void_unit returned no rows', { unit_id: entry.unit_id })
          results.push({
            unit_id: entry.unit_id,
            action: entry.action,
            succeeded: false,
            error: 'void_unit returned no result — check server logs.',
          })
          continue
        }

        authedLog.info('Unit voided', {
          unit_id: entry.unit_id,
          ledger_entry_id: row.ledger_entry_id,
        })

        results.push({
          unit_id: entry.unit_id,
          action: entry.action,
          succeeded: true,
          ledger_entry_id: row.ledger_entry_id,
        })
      }
      // Future:
      // else if (entry.action === 'received') { ... }
      // else if (entry.action === 'hologram_applied') { ... }
    }

    // ── Step 7: Build summary and respond ────────────────────────────────────

    const succeededCount = results.filter((r) => r.succeeded).length
    const failedCount = results.length - succeededCount

    const summary: ResultSummary = {
      total: results.length,
      succeeded: succeededCount,
      failed: failedCount,
      all_succeeded: failedCount === 0,
    }

    authedLog.info('Ledger entry operation complete', {
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
    })

    return jsonResponse(req, { summary, results } satisfies ResponsePayload)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
