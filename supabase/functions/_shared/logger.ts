/**
 * Structured JSON logger for GTG Edge Functions.
 *
 * Emits one JSON line per log call to stdout (info/debug) or stderr
 * (warn/error), matching the Supabase Function Logs format so entries are
 * queryable in the dashboard and compatible with external log aggregators.
 *
 * ─── Log line shape ───────────────────────────────────────────────────────────
 *
 *   {
 *     "level":     "info",
 *     "ts":        "2026-03-06T12:00:00.000Z",
 *     "fn":        "process-royalties",
 *     "requestId": "a1b2c3d4",
 *     "userId":    "uuid...",          // present after withUser() is called
 *     "msg":       "Royalty run complete",
 *     "ctx":       { "periodStart": "2026-01-01" }   // present when data is passed
 *   }
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // At the top of the handler:
 *   const log = createLogger('my-function', req)
 *   log.info('Handler invoked')
 *
 *   // After authentication:
 *   const log = createLogger('my-function', req).withUser(user.id)
 *   log.info('Processing request', { orderId })
 *
 *   // On error:
 *   log.error('DB query failed', { table: 'orders', code: error.code })
 *
 * ─── Log level ────────────────────────────────────────────────────────────────
 *
 *   Controlled by the LOG_LEVEL environment variable (set via Supabase secrets
 *   or supabase/.env.local for local dev). Defaults to "info".
 *
 *   Valid values: debug | info | warn | error
 *
 *   Example .env.local entry:
 *     LOG_LEVEL=debug
 *
 * ─── What NOT to log ─────────────────────────────────────────────────────────
 *
 *   - JWT tokens or Bearer strings
 *   - Service role keys or API secrets
 *   - Full request bodies containing payment or PII data
 *   - Supabase error details that may expose schema structure to callers
 *     (log the detail here, return a generic message to the client)
 */

// ─── Level ────────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
}

function resolveMinLevel(): LogLevel {
  const raw = Deno.env.get('LOG_LEVEL')?.toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw
  }
  return 'info'
}

// Resolved once per function cold-start — LOG_LEVEL does not change mid-request.
const MIN_LEVEL: LogLevel = resolveMinLevel()

// ─── Context ──────────────────────────────────────────────────────────────────

interface LogContext {
  /** Edge Function name — used to filter logs per function in the dashboard. */
  readonly fn: string
  /**
   * Per-request trace ID.
   *
   * Sourced from the x-request-id header injected by the Supabase runtime.
   * Falls back to a short random hex string when the header is absent (local
   * development without the full runtime).
   */
  readonly requestId: string
  /** Authenticated user ID. Set by calling withUser(). */
  readonly userId?: string
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  /**
   * Return a new Logger with the userId bound to every subsequent log line.
   *
   * Call this immediately after a successful auth.getUser() to attach the
   * user identity to all logs for the remainder of the request.
   *
   * @example
   *   const log = createLogger('my-function', req).withUser(user.id)
   */
  withUser(userId: string): Logger
}

// ─── Implementation ───────────────────────────────────────────────────────────

function emit(level: LogLevel, context: LogContext, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return

  const entry: Record<string, unknown> = {
    level,
    ts:        new Date().toISOString(),
    fn:        context.fn,
    requestId: context.requestId,
    msg:       message,
  }

  if (context.userId !== undefined) {
    entry['userId'] = context.userId
  }

  if (data !== undefined && Object.keys(data).length > 0) {
    entry['ctx'] = data
  }

  const line = JSON.stringify(entry)

  // info/debug → stdout; warn/error → stderr.
  // Supabase Function Logs surfaces both; external collectors can split by stream.
  if (level === 'warn' || level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

function makeLogger(context: LogContext): Logger {
  return {
    debug: (msg, data) => emit('debug', context, msg, data),
    info:  (msg, data) => emit('info',  context, msg, data),
    warn:  (msg, data) => emit('warn',  context, msg, data),
    error: (msg, data) => emit('error', context, msg, data),
    withUser: (userId) => makeLogger({ ...context, userId }),
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a request-scoped logger bound to the given function name and request.
 *
 * Call once at the top of each Edge Function handler, before any other work.
 * The logger captures the request ID from the incoming headers so every log
 * line for this request is traceable in the dashboard.
 *
 * @param functionName  The name of this Edge Function (matches the directory name).
 * @param req           The incoming HTTP request (used to extract the request ID).
 *
 * @example
 *   Deno.serve(async (req) => {
 *     const log = createLogger('process-royalties', req)
 *     log.info('Handler invoked')
 *
 *     const preflight = handleCors(req)
 *     if (preflight) return preflight
 *
 *     // ... auth ...
 *     const authedLog = log.withUser(user.id)
 *     authedLog.info('Processing royalty run', { periodStart })
 *   })
 */
export function createLogger(functionName: string, req: Request): Logger {
  const requestId =
    req.headers.get('x-request-id') ??
    crypto.getRandomValues(new Uint8Array(4))
      .reduce((hex, b) => hex + b.toString(16).padStart(2, '0'), '')

  return makeLogger({ fn: functionName, requestId })
}
