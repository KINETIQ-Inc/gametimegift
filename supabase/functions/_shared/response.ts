/**
 * JSON response helpers for GTG Edge Functions.
 *
 * All helpers attach the correct CORS headers by reflecting the origin from
 * the incoming request. Pass `req` from the handler scope on every call.
 *
 * Response shape contract
 * -----------------------
 * Success:  { data: T }             — 2xx status
 * Error:    { error: string }       — 4xx / 5xx status
 *
 * Keeping this consistent across all functions lets the client-side API layer
 * handle responses generically without per-function parsing logic.
 */

import { corsHeaders } from './cors.ts'

// ─── Success ──────────────────────────────────────────────────────────────────

/**
 * Return a JSON success response with CORS headers.
 *
 * @example
 *   return jsonResponse(req, { orderId: '...' })
 *   return jsonResponse(req, { items }, 201)
 */
export function jsonResponse<T>(req: Request, data: T, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    },
  })
}

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * Return a JSON error response with CORS headers.
 *
 * The message is surfaced to the caller as-is. Do not include internal
 * implementation details, stack traces, or database error messages in the
 * message — use a generic message and log the detail server-side instead.
 *
 * @example
 *   return jsonError(req, 'Unauthorized', 401)
 *   return jsonError(req, 'Order not found', 404)
 *   return jsonError(req, 'Internal server error', 500)
 */
export function jsonError(req: Request, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    },
  })
}

// ─── Auth Errors (convenience) ────────────────────────────────────────────────

/** 401 — no valid JWT */
export const unauthorized = (req: Request) => jsonError(req, 'Unauthorized', 401)

/** 403 — valid JWT but insufficient role */
export const forbidden = (req: Request) => jsonError(req, 'Forbidden', 403)
