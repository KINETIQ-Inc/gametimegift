/**
 * GTG Edge Function — bulk-upload-units
 *
 * Serialized unit bulk receiving via CSV upload (4B-1).
 * Accepts a multipart/form-data request containing batch metadata fields and
 * a CSV file of serial numbers. Creates the manufacturing batch and inserts
 * all units atomically via bulk_receive_units.
 *
 * ─── CSV format ───────────────────────────────────────────────────────────────
 *
 * Single-column CSV with a required header row:
 *
 *   serial_number
 *   GTG-CLC-2026-0001
 *   GTG-CLC-2026-0002
 *   GTG-CLC-2026-0003
 *
 * Rules:
 *   - Header must be exactly "serial_number" (case-insensitive).
 *   - Each data row: one serial number, 1–100 characters, no leading/trailing whitespace.
 *   - BOM (byte order mark) is stripped automatically (common in Excel exports).
 *   - Windows line endings (CRLF) are handled.
 *   - Blank lines are ignored.
 *   - Duplicate serial numbers within the CSV are rejected before DB insert.
 *
 * ─── Request format ───────────────────────────────────────────────────────────
 *
 * Content-Type: multipart/form-data
 *
 * Fields:
 *   product_id            (required) UUID of the product being received
 *   batch_number          (required) Unique batch identifier, e.g. BATCH-20260306-CLC-001
 *                                    Format: ^[A-Z0-9][A-Z0-9-]{2,79}$
 *   expected_unit_count   (required) Integer > 0 — supplier's declared quantity
 *   purchase_order_number (optional) Supplier's PO reference number
 *   notes                 (optional) Free-text receiving notes
 *   file                  (required) CSV attachment (text/csv or .csv)
 *
 * ─── Over-shipment guard ──────────────────────────────────────────────────────
 *
 * If the CSV contains more unique serial numbers than
 * ceil(expected_unit_count × 1.1), the request is rejected with 400.
 * A 10% tolerance is permitted for mis-shipments; larger overages require
 * investigation before receiving.
 *
 * ─── Conflict handling ────────────────────────────────────────────────────────
 *
 * Serial numbers already present in the DB (from any prior batch) are silently
 * skipped — they do not cause the upload to fail. The response reports them in
 * conflict_serials[] so the admin can investigate. A 100% conflict rate (every
 * serial was already in the DB) still returns 200 with received_count = 0.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 *
 * batch_number must be globally unique (manufacturing_batches constraint).
 * Retrying an upload with the same batch_number returns 409. To retry a failed
 * upload, use a new batch_number or investigate and void the prior attempt.
 *
 * ─── Authorization ────────────────────────────────────────────────────────────
 *
 * ADMIN_ROLES only: super_admin, admin.
 *
 * ─── Request ──────────────────────────────────────────────────────────────────
 *
 *   POST /functions/v1/bulk-upload-units
 *   Authorization: Bearer <admin-jwt>
 *   Content-Type: multipart/form-data
 *
 *   --boundary
 *   Content-Disposition: form-data; name="product_id"
 *   <uuid>
 *   --boundary
 *   Content-Disposition: form-data; name="batch_number"
 *   BATCH-20260306-CLC-001
 *   --boundary
 *   Content-Disposition: form-data; name="expected_unit_count"
 *   100
 *   --boundary
 *   Content-Disposition: form-data; name="file"; filename="units.csv"
 *   Content-Type: text/csv
 *   serial_number
 *   GTG-CLC-2026-0001
 *   ...
 *   --boundary--
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *
 *   201 {
 *     "data": {
 *       "batch_id":             "<uuid>",
 *       "batch_number":         "BATCH-20260306-CLC-001",
 *       "product_id":           "<uuid>",
 *       "sku":                  "APP-NIKE-JERSEY-M",
 *       "license_body":         "CLC",
 *       "royalty_rate_stamped": 0.145,
 *       "expected_unit_count":  100,
 *       "submitted_count":      100,
 *       "received_count":       97,
 *       "conflict_count":       3,
 *       "conflict_serials":     ["GTG-CLC-2025-0042", "GTG-CLC-2025-0043", "GTG-CLC-2025-0044"]
 *     }
 *   }
 *
 * ─── Error responses ──────────────────────────────────────────────────────────
 *
 *   400  Validation failure (see message)
 *   401  Unauthenticated
 *   403  Forbidden (non-admin role)
 *   409  batch_number already exists
 *   500  Internal server error
 */

import { ADMIN_ROLES, verifyRole } from '../_shared/auth.ts'
import { handleCors } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'
import { jsonError, jsonResponse, unauthorized } from '../_shared/response.ts'
import { createAdminClient, createUserClient } from '../_shared/supabase.ts'

// ─── Constants ────────────────────────────────────────────────────────────────

const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BATCH_NUMBER_RE = /^[A-Z0-9][A-Z0-9-]{2,79}$/

// Serial numbers: 1–100 printable non-whitespace characters
const SERIAL_NUMBER_RE = /^[^\s]{1,100}$/

const MAX_UNITS_PER_UPLOAD  = 5_000
const OVERSHIPMENT_TOLERANCE = 1.1   // matches manufacturing_batches_received_not_excess

// PostgreSQL unique_violation error code
const PG_UNIQUE_VIOLATION = '23505'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UploadResult {
  batch_id:             string
  batch_number:         string
  product_id:           string
  sku:                  string
  license_body:         string
  royalty_rate_stamped: number
  expected_unit_count:  number
  submitted_count:      number
  received_count:       number
  conflict_count:       number
  conflict_serials:     string[]
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

interface ParseResult {
  serials: string[]
  error:   string | null
}

function parseCSV(rawText: string): ParseResult {
  // Strip UTF-8 BOM (common in Excel-exported CSVs)
  const text = rawText.replace(/^\uFEFF/, '')

  // Split on any line ending, trim each line, drop blanks
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) {
    return { serials: [], error: 'CSV file is empty.' }
  }

  // Validate header
  if (lines[0].toLowerCase() !== 'serial_number') {
    return {
      serials: [],
      error:
        `CSV must have a 'serial_number' header in the first row. ` +
        `Got: '${lines[0]}'.`,
    }
  }

  const dataLines = lines.slice(1)

  if (dataLines.length === 0) {
    return { serials: [], error: 'CSV contains a header but no data rows.' }
  }

  // Validate each serial number
  for (let i = 0; i < dataLines.length; i++) {
    const sn = dataLines[i]
    if (!SERIAL_NUMBER_RE.test(sn)) {
      return {
        serials: [],
        error:
          `Invalid serial number on row ${i + 2} (data row ${i + 1}): '${sn}'. ` +
          'Serial numbers must be 1–100 non-whitespace characters.',
      }
    }
  }

  return { serials: dataLines, error: null }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Step 1: Logger ──────────────────────────────────────────────────────────

  const log = createLogger('bulk-upload-units', req)
  log.info('Handler invoked', { method: req.method })

  // ── Step 2: CORS preflight ──────────────────────────────────────────────────

  const preflight = handleCors(req)
  if (preflight) return preflight

  try {
    // ── Step 3: Authenticate ────────────────────────────────────────────────────

    const userClient = createUserClient(req)
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    if (authError !== null || user === null) {
      log.warn('Authentication failed', { error: authError?.message })
      return unauthorized(req)
    }

    // ── Step 4: Authorize ───────────────────────────────────────────────────────

    const { authorized, denied } = verifyRole(user, ADMIN_ROLES, req)
    if (denied) {
      log.warn('Authorization failed', { userId: user.id })
      return denied
    }

    const authedLog = log.withUser(authorized.id)
    authedLog.info('Authenticated', { role: authorized.role })

    // ── Step 5: Parse multipart form data ───────────────────────────────────────

    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return jsonError(req, 'Request must be multipart/form-data.', 400)
    }

    // ── Step 6: Extract and validate form fields ────────────────────────────────

    const productId           = formData.get('product_id')
    const batchNumber         = formData.get('batch_number')
    const expectedUnitCountRaw = formData.get('expected_unit_count')
    const purchaseOrderNumber = formData.get('purchase_order_number')
    const notes               = formData.get('notes')
    const file                = formData.get('file')

    // product_id
    if (!productId || typeof productId !== 'string' || !UUID_RE.test(productId)) {
      return jsonError(req, 'product_id must be a valid UUID.', 400)
    }

    // batch_number
    if (!batchNumber || typeof batchNumber !== 'string') {
      return jsonError(req, 'batch_number is required.', 400)
    }
    if (!BATCH_NUMBER_RE.test(batchNumber)) {
      return jsonError(
        req,
        "batch_number must be uppercase alphanumeric with hyphens, 3–80 characters " +
        "(e.g. 'BATCH-20260306-CLC-001'). Must start with a letter or digit.",
        400,
      )
    }

    // expected_unit_count
    if (!expectedUnitCountRaw || typeof expectedUnitCountRaw !== 'string') {
      return jsonError(req, 'expected_unit_count is required.', 400)
    }
    const expectedUnitCount = parseInt(expectedUnitCountRaw, 10)
    if (!Number.isInteger(expectedUnitCount) || expectedUnitCount <= 0) {
      return jsonError(req, 'expected_unit_count must be a positive integer.', 400)
    }

    // purchase_order_number — optional string
    const poNumber = (purchaseOrderNumber && typeof purchaseOrderNumber === 'string')
      ? purchaseOrderNumber.trim() || null
      : null

    // notes — optional string
    const batchNotes = (notes && typeof notes === 'string')
      ? notes.trim() || null
      : null

    // file
    if (!file || !(file instanceof File)) {
      return jsonError(req, "A CSV file must be attached in the 'file' field.", 400)
    }

    // ── Step 7: Parse CSV ───────────────────────────────────────────────────────

    let csvText: string
    try {
      csvText = await file.text()
    } catch {
      return jsonError(req, 'Could not read the uploaded file.', 400)
    }

    const { serials, error: parseError } = parseCSV(csvText)
    if (parseError !== null) {
      return jsonError(req, parseError, 400)
    }

    // ── Step 8: Validate serial numbers ────────────────────────────────────────

    if (serials.length > MAX_UNITS_PER_UPLOAD) {
      return jsonError(
        req,
        `CSV contains ${serials.length} serial numbers. Maximum per upload is ${MAX_UNITS_PER_UPLOAD}. ` +
        'Split the shipment into multiple uploads if needed.',
        400,
      )
    }

    // Detect duplicates within the CSV itself
    const uniqueSerials = new Set(serials)
    if (uniqueSerials.size < serials.length) {
      const seen = new Set<string>()
      const dupes: string[] = []
      for (const sn of serials) {
        if (seen.has(sn)) dupes.push(sn)
        else seen.add(sn)
      }
      return jsonError(
        req,
        `CSV contains ${serials.length - uniqueSerials.size} duplicate serial number(s). ` +
        `Each serial must appear exactly once. Duplicates: ${dupes.slice(0, 10).join(', ')}` +
        (dupes.length > 10 ? ` … and ${dupes.length - 10} more.` : '.'),
        400,
      )
    }

    // Over-shipment guard (mirrors DB constraint)
    const maxAllowed = Math.ceil(expectedUnitCount * OVERSHIPMENT_TOLERANCE)
    if (serials.length > maxAllowed) {
      return jsonError(
        req,
        `CSV contains ${serials.length} serial numbers but expected_unit_count is ` +
        `${expectedUnitCount} (max allowed with 10% tolerance: ${maxAllowed}). ` +
        'Correct the expected_unit_count or investigate the over-shipment before receiving.',
        400,
      )
    }

    // ── Step 9: Bulk receive ────────────────────────────────────────────────────

    const admin = createAdminClient()

    authedLog.info('Starting bulk receive', {
      batch_number:         batchNumber,
      product_id:           productId,
      expected_unit_count:  expectedUnitCount,
      submitted_count:      serials.length,
    })

    const { data: result, error: rpcError } = await admin.rpc(
      'bulk_receive_units',
      {
        p_batch_number:          batchNumber,
        p_product_id:            productId,
        p_expected_unit_count:   expectedUnitCount,
        p_purchase_order_number: poNumber,
        p_notes:                 batchNotes,
        p_serial_numbers:        serials,
        p_received_by:           authorized.id,
      },
    )

    if (rpcError !== null) {
      // Batch number already exists — surface as 409
      if (rpcError.code === PG_UNIQUE_VIOLATION) {
        authedLog.warn('Batch number conflict', { batch_number: batchNumber })
        return jsonError(
          req,
          `A batch with batch_number '${batchNumber}' already exists. ` +
          'batch_number must be globally unique. Use a different batch_number to retry.',
          409,
        )
      }
      const gtgMatch = rpcError.message.match(/\[GTG\][^.]+\./)
      authedLog.error('bulk_receive_units failed', { error: rpcError.message })
      return jsonError(req, gtgMatch ? gtgMatch[0] : 'Internal server error', 500)
    }

    const outcome = result as UploadResult

    authedLog.info('Bulk receive complete', {
      batch_id:       outcome.batch_id,
      batch_number:   outcome.batch_number,
      sku:            outcome.sku,
      submitted_count: outcome.submitted_count,
      received_count:  outcome.received_count,
      conflict_count:  outcome.conflict_count,
    })

    return jsonResponse(req, outcome, 201)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Unhandled error', { message })
    return jsonError(req, 'Internal server error', 500)
  }
})
