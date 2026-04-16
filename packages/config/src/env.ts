import {
  requireEnv,
  requireEnvBoolean,
  requireEnvRate,
  requireEnvUrl,
  requireEnvOneOf,
  requireEnvList,
} from './require-env'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AppEnvironment = 'development' | 'staging' | 'production'

/**
 * Validated, typed environment configuration for all GTG browser apps.
 *
 * All fields are derived from VITE_* environment variables — the only vars
 * accessible to browser bundles. Server-only vars (SUPABASE_SERVICE_ROLE_KEY,
 * STRIPE_SECRET_KEY) are never present here and must never be added.
 *
 * Populated once at startup by initEnv(). Read via getEnv() everywhere else.
 * All fields are readonly — the env contract is immutable after initialization.
 */
export interface AppEnv {
  // ── Supabase ───────────────────────────────────────────────────────────────
  /** Supabase project URL. e.g. https://<ref>.supabase.co */
  readonly supabaseUrl: string
  /** Supabase anon (public) key. Safe for browser exposure. */
  readonly supabaseAnonKey: string

  // ── Stripe ─────────────────────────────────────────────────────────────────
  /** Stripe publishable key (pk_live_* or pk_test_*). Browser-safe. */
  readonly stripePublishableKey: string

  // ── Application ────────────────────────────────────────────────────────────
  /** Deployment environment. Governs logging verbosity and feature flags. */
  readonly appEnv: AppEnvironment

  // ── Licensing ──────────────────────────────────────────────────────────────
  /**
   * Whether CLC-licensed products are active in this deployment.
   * When false, CLC royalty reporting is suppressed.
   */
  readonly licenseCLCActive: boolean
  /**
   * Whether U.S. Army-licensed products are active in this deployment.
   * When false, Army royalty reporting is suppressed.
   */
  readonly licenseArmyActive: boolean
  /**
   * Default CLC royalty rate as a decimal fraction (e.g. 0.145 = 14.5%).
   * Used as the fallback when no product-level override is defined.
   * Must be > 0 and ≤ 1.
   */
  readonly royaltyRateCLC: number

  // ── Hologram ───────────────────────────────────────────────────────────────
  /**
   * Base URL for hologram verification API.
   * Full verify URL = hologramVerifyBaseUrl + hologramId.
   * Must not have a trailing slash.
   */
  readonly hologramVerifyBaseUrl: string

  // ── Fraud ──────────────────────────────────────────────────────────────────
  /**
   * UserRoles that hold fraud lock authority.
   * Parsed from a comma-separated string: "super_admin,admin".
   * Checked at the policy boundary before any lock operation.
   */
  readonly fraudAuthorityRoles: readonly string[]
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _env: AppEnv | null = null

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Validate and parse all required environment variables.
 *
 * Must be called ONCE at application startup — before configureSupabase()
 * and before createRoot(). Hard-fails immediately with a named error if any
 * required variable is missing, empty, or malformed.
 *
 * In Vite apps, pass import.meta.env directly:
 *
 *   const env = initEnv(import.meta.env)
 *
 * import.meta.env is typed as Record<string, string> in Vite's vite/client
 * types. This function accepts Record<string, string | undefined> to remain
 * compatible with non-Vite environments (Node process.env, Deno.env.toObject()).
 *
 * @throws If any required variable is missing, empty, or invalid.
 * @throws If called more than once.
 */
/**
 * Patterns that identify server-only secrets.
 * If any of these appear in a VITE_-prefixed key, the app is immediately
 * terminated — the secret would be embedded in the browser bundle.
 *
 * Extend this list when new server-only secret types are introduced.
 */
const SERVER_SECRET_PATTERNS: readonly string[] = [
  'SERVICE_ROLE',    // SUPABASE_SERVICE_ROLE_KEY — full DB access, bypasses RLS
  'SECRET_KEY',      // STRIPE_SECRET_KEY — server-side Stripe API
  'WEBHOOK_SECRET',  // STRIPE_WEBHOOK_SECRET — validates incoming Stripe events
]

/**
 * Scan the raw env for any VITE_-prefixed key that contains a server-secret
 * pattern. Throws before any other validation so the exposure is caught even
 * if the rest of the env is malformed.
 *
 * This catches the most common mistake: a developer copies a working .env
 * snippet that incorrectly prefixes a secret with VITE_, causing it to be
 * inlined into every browser bundle by Vite's static replacement.
 */
function assertNoExposedSecrets(raw: Record<string, string | undefined>): void {
  for (const key of Object.keys(raw)) {
    if (!key.startsWith('VITE_')) continue
    for (const pattern of SERVER_SECRET_PATTERNS) {
      if (key.includes(pattern)) {
        throw new Error(
          `[GTG] SECURITY VIOLATION: Server-only secret exposed as a browser variable: ${key}\n` +
          `  → Variables prefixed with VITE_ are embedded in the browser bundle by Vite.\n` +
          `  → Remove the VITE_ prefix. The correct key name is: ${key.replace('VITE_', '')}\n` +
          `  → Server-only secrets must NEVER be prefixed with VITE_.`,
        )
      }
    }
  }
}

export function initEnv(raw: Record<string, string | undefined>): AppEnv {
  if (_env !== null) {
    throw new Error(
      '[GTG] initEnv() was called after the environment was already initialized.\n' +
      '  → initEnv() must be called once at startup. Check your entry point for duplicate calls.',
    )
  }

  // Security check runs before all other validation.
  // A VITE_-prefixed server secret is a critical misconfiguration regardless
  // of whether any other required variable is missing.
  assertNoExposedSecrets(raw)

  const env: AppEnv = {
    supabaseUrl:           requireEnvUrl(raw, 'VITE_SUPABASE_URL'),
    supabaseAnonKey:       requireEnv(raw, 'VITE_SUPABASE_ANON_KEY'),
    stripePublishableKey:  requireEnv(raw, 'VITE_STRIPE_PUBLISHABLE_KEY'),
    appEnv:                requireEnvOneOf(raw, 'VITE_APP_ENV', ['development', 'staging', 'production'] as const),
    licenseCLCActive:      requireEnvBoolean(raw, 'VITE_LICENSE_CLC_ACTIVE'),
    licenseArmyActive:     requireEnvBoolean(raw, 'VITE_LICENSE_ARMY_ACTIVE'),
    royaltyRateCLC:        requireEnvRate(raw, 'VITE_ROYALTY_RATE_CLC'),
    hologramVerifyBaseUrl: requireEnvUrl(raw, 'VITE_HOLOGRAM_VERIFY_BASE_URL'),
    fraudAuthorityRoles:   requireEnvList(raw, 'VITE_FRAUD_AUTHORITY_ROLES'),
  }

  _env = env
  return env
}

// ─── Getter ───────────────────────────────────────────────────────────────────

/**
 * Returns the validated environment singleton.
 *
 * Safe to call anywhere after initEnv() has been called.
 *
 * @throws If initEnv() has not been called.
 *
 * @example
 *   import { getEnv } from '@gtg/config'
 *   const { supabaseUrl, royaltyRateCLC } = getEnv()
 */
export function getEnv(): AppEnv {
  if (_env === null) {
    throw new Error(
      '[GTG] getEnv() called before initEnv().\n' +
      '  → Call initEnv(import.meta.env) in your application entry point\n' +
      '  → before any component renders or any Supabase call is made.',
    )
  }
  return _env
}

// ─── Predicate ────────────────────────────────────────────────────────────────

/**
 * Returns true if initEnv() has been called successfully.
 * Use in test setup to avoid duplicate initialization errors.
 */
export function isEnvInitialized(): boolean {
  return _env !== null
}

// ─── Internal — test reset ────────────────────────────────────────────────────

/**
 * Internal — used by testing.ts only. Not exported from the public barrel.
 * Resets the singleton so initEnv() can be called again in the next test.
 */
export function _resetEnvForTesting(): void {
  _env = null
}
