/**
 * Cross-environment, source-explicit env var validators.
 *
 * All functions take an explicit `source` argument — never reading from
 * a global like process.env or import.meta.env directly. This keeps them
 * usable in every runtime: Vite browser, Node, Deno, React Native.
 *
 * The caller is responsible for supplying the source:
 *
 *   Vite browser apps  → import.meta.env
 *   Node scripts       → process.env
 *   Deno Edge Funcs    → Deno.env.toObject()
 *   React Native       → values from expo-constants
 *   Tests              → a plain object literal
 *
 * All functions throw synchronously with a specific error message naming
 * the missing or malformed variable. No silent fallbacks.
 */

// ─── Source Type ──────────────────────────────────────────────────────────────

/**
 * The shape of any env source object.
 * Compatible with import.meta.env, process.env, and Deno.env.toObject().
 */
export type EnvSource = Record<string, string | undefined>

// ─── requireEnv ───────────────────────────────────────────────────────────────

/**
 * Require a string environment variable.
 *
 * The foundational validator — all other requireEnv* functions build on this.
 * Returns the trimmed value if present and non-empty.
 *
 * @throws If the variable is absent, undefined, or blank after trimming.
 *
 * @example
 *   // Vite
 *   const url = requireEnv(import.meta.env, 'VITE_SUPABASE_URL')
 *
 *   // Edge Function (Deno)
 *   const key = requireEnv(Deno.env.toObject(), 'SUPABASE_SERVICE_ROLE_KEY')
 *
 *   // Node script
 *   const secret = requireEnv(process.env, 'STRIPE_SECRET_KEY')
 */
export function requireEnv(source: EnvSource, key: string): string {
  const val = source[key]
  if (val === undefined || val.trim() === '') {
    throw new Error(
      `[GTG] Missing required environment variable: ${key}\n` +
      `  → Add it to your .env file. See .env.example for reference.\n` +
      `  → In Vite apps, variables must be prefixed with VITE_ to be browser-accessible.`,
    )
  }
  return val.trim()
}

// ─── optionalEnv ─────────────────────────────────────────────────────────────

/**
 * Read an optional environment variable, returning a fallback if absent.
 *
 * Use for variables that have a safe default and are not required for
 * core functionality. Never use this for credentials, URLs, or rate values.
 *
 * @example
 *   const logLevel = optionalEnv(import.meta.env, 'VITE_LOG_LEVEL', 'info')
 */
export function optionalEnv(source: EnvSource, key: string, fallback: string): string {
  const val = source[key]
  if (val === undefined || val.trim() === '') return fallback
  return val.trim()
}

// ─── Typed Parsers ────────────────────────────────────────────────────────────

/**
 * Require a boolean environment variable.
 *
 * Accepts exactly "true" or "false" (case-sensitive, no leading/trailing space
 * after trimming). Any other value is a hard error — ambiguous values like
 * "yes", "1", "on" are not accepted.
 *
 * @throws If absent, blank, or not exactly "true" or "false".
 *
 * @example
 *   const active = requireEnvBoolean(import.meta.env, 'VITE_LICENSE_CLC_ACTIVE')
 */
export function requireEnvBoolean(source: EnvSource, key: string): boolean {
  const val = requireEnv(source, key)
  if (val !== 'true' && val !== 'false') {
    throw new Error(
      `[GTG] Environment variable ${key} must be exactly "true" or "false".\n` +
      `  → Got: "${val}"\n` +
      `  → Accepted values: true, false`,
    )
  }
  return val === 'true'
}

/**
 * Require a finite number environment variable.
 *
 * Parses via Number(). Rejects NaN, Infinity, and non-numeric strings.
 * Does not constrain the range — use requireEnvRate() for decimal fractions
 * bounded to (0, 1].
 *
 * @throws If absent, blank, or not a finite number.
 *
 * @example
 *   const timeout = requireEnvNumber(process.env, 'REQUEST_TIMEOUT_MS')
 */
export function requireEnvNumber(source: EnvSource, key: string): number {
  const val = requireEnv(source, key)
  const num = Number(val)
  if (!Number.isFinite(num)) {
    throw new Error(
      `[GTG] Environment variable ${key} must be a finite number.\n` +
      `  → Got: "${val}"`,
    )
  }
  return num
}

/**
 * Require a royalty/commission rate environment variable.
 *
 * Must be a finite decimal fraction strictly greater than 0 and at most 1.
 * A rate of 0 is a configuration error (zero-royalty agreements are modeled
 * at the LicenseHolder level). A rate above 1 would generate royalties larger
 * than the sale amount.
 *
 * @throws If absent, blank, non-numeric, ≤ 0, or > 1.
 *
 * @example
 *   const rate = requireEnvRate(import.meta.env, 'VITE_ROYALTY_RATE_CLC')
 *   // rate is guaranteed: 0 < rate <= 1
 */
export function requireEnvRate(source: EnvSource, key: string): number {
  const val = requireEnv(source, key)
  const num = Number(val)
  if (!Number.isFinite(num) || num <= 0 || num > 1) {
    throw new Error(
      `[GTG] Environment variable ${key} must be a decimal fraction greater than 0 and at most 1.\n` +
      `  → Got: "${val}"\n` +
      `  → Example: 0.145 represents a 14.5% rate.`,
    )
  }
  return num
}

/**
 * Require a URL environment variable.
 *
 * Must start with http:// or https:// and must not have a trailing slash.
 * The trailing-slash constraint prevents double-slash paths when the URL is
 * used as a base (e.g. hologramVerifyBaseUrl + '/' + hologramId).
 *
 * Does not validate host format — malformed hostnames will surface as
 * network errors from the SDK that receives the URL, with full context.
 *
 * @throws If absent, blank, missing protocol, or has trailing slash.
 *
 * @example
 *   const supabaseUrl = requireEnvUrl(import.meta.env, 'VITE_SUPABASE_URL')
 */
export function requireEnvUrl(source: EnvSource, key: string): string {
  const val = requireEnv(source, key)
  if (!val.startsWith('http://') && !val.startsWith('https://')) {
    throw new Error(
      `[GTG] Environment variable ${key} must start with http:// or https://.\n` +
      `  → Got: "${val}"`,
    )
  }
  if (val.endsWith('/')) {
    throw new Error(
      `[GTG] Environment variable ${key} must not have a trailing slash.\n` +
      `  → Got: "${val}"\n` +
      `  → Use: "${val.slice(0, -1)}"`,
    )
  }
  return val
}

/**
 * Require an environment variable whose value is one of a fixed set of strings.
 *
 * The allowed set is enforced at runtime and the return type is narrowed to
 * the literal union T, giving type-safe access to the value downstream.
 *
 * @throws If absent, blank, or not a member of the allowed set.
 *
 * @example
 *   const appEnv = requireEnvOneOf(
 *     import.meta.env,
 *     'VITE_APP_ENV',
 *     ['development', 'staging', 'production'] as const,
 *   )
 *   // typeof appEnv === 'development' | 'staging' | 'production'
 */
export function requireEnvOneOf<T extends string>(
  source: EnvSource,
  key: string,
  allowed: readonly T[],
): T {
  const val = requireEnv(source, key)
  if (!(allowed as readonly string[]).includes(val)) {
    throw new Error(
      `[GTG] Environment variable ${key} must be one of: ${allowed.join(', ')}.\n` +
      `  → Got: "${val}"`,
    )
  }
  return val as T
}

/**
 * Require a comma-separated list environment variable.
 *
 * Splits on commas, trims each entry, and removes empty strings produced by
 * trailing commas or accidental double-commas. Requires at least one entry
 * after cleaning — a variable defined as "" or "," is treated as absent.
 *
 * The returned array is readonly — mutating the list is a logic error.
 *
 * @throws If absent, blank, or produces an empty list after splitting.
 *
 * @example
 *   const roles = requireEnvList(import.meta.env, 'VITE_FRAUD_AUTHORITY_ROLES')
 *   // roles === ['super_admin', 'admin']
 */
export function requireEnvList(source: EnvSource, key: string): readonly string[] {
  const val = requireEnv(source, key)
  const parts = val.split(',').map(s => s.trim()).filter(s => s.length > 0)
  if (parts.length === 0) {
    throw new Error(
      `[GTG] Environment variable ${key} must contain at least one comma-separated value.\n` +
      `  → Got: "${val}"\n` +
      `  → Example: "super_admin,admin"`,
    )
  }
  return parts
}
