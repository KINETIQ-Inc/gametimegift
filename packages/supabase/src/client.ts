import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types'

// ─── Global Registry Guard ────────────────────────────────────────────────────
//
// The module-local `_client` variable is the primary singleton.
// The globalThis registry is a secondary guard that survives duplicate module
// evaluation — if the bundler or a CDN loads @gtg/supabase twice, both
// module instances share the same reference via Symbol.for's global registry.
//
// Symbol.for('gtg.supabase.client') is stable across all JS realms in a
// given runtime because it uses the global symbol registry, not the module
// instance. This is the same technique React uses to detect duplicate React
// copies (Symbol.for('react.element')).

declare global {
  // var (not let/const) is required for globalThis augmentation.
  // eslint-disable-next-line no-var
  var __gtg_supabase_client: SupabaseClient<Database> | undefined
}

function _getGlobalClient(): SupabaseClient<Database> | null {
  return globalThis.__gtg_supabase_client ?? null
}

function _setGlobalClient(client: SupabaseClient<Database>): void {
  globalThis.__gtg_supabase_client = client
}

// ─── Module-Local Singleton ───────────────────────────────────────────────────
//
// Fast-path cache. Checked before the globalThis lookup on every
// getSupabaseClient() call. Synced from globalThis on first access if
// another module instance already created the client.

let _client: SupabaseClient<Database> | null = null

/**
 * Internal — used by testing.ts only. Not exported from the public barrel.
 *
 * Resets BOTH the module-local cache and the globalThis registry so that
 * configureSupabase() can be called again in the next test. The module-local
 * variable must be reset here because it is private to this module scope and
 * cannot be cleared from outside without this dedicated function.
 */
export function _resetForTesting(): void {
  _client = null
  globalThis.__gtg_supabase_client = undefined
}

// ─── Configure ────────────────────────────────────────────────────────────────

/**
 * Initialize the Supabase singleton with explicit credentials.
 *
 * Must be called ONCE at application startup, before any getSupabaseClient()
 * call. The correct call site per environment:
 *
 *   Vite apps (storefront, admin, consultant)
 *     → apps/<name>/src/main.tsx
 *     → Pass import.meta.env.VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
 *
 *   React Native (mobile — future phase)
 *     → App entry point
 *     → Pass values from expo-constants or react-native-config
 *
 *   Edge Functions (Supabase — future phase)
 *     → Function handler
 *     → Pass Deno.env.get('SUPABASE_URL') and SUPABASE_ANON_KEY
 *
 * This package deliberately does NOT read import.meta.env internally.
 * Doing so would couple a shared package to the Vite build environment,
 * breaking mobile and server consumers. Credential injection is always
 * the caller's responsibility.
 *
 * @throws If url or anonKey is empty or missing.
 * @throws If the client has already been initialized (either by this module
 *         instance or by a duplicate instance detected via globalThis).
 */
export function configureSupabase(url: string, anonKey: string): void {
  // Check local cache first.
  if (_client !== null) {
    throw new Error(
      '[GTG] configureSupabase() was called after the client was already initialized. ' +
      'configureSupabase() must be called once at startup, before any ' +
      'getSupabaseClient() calls. Check your application entry point for duplicate calls.',
    )
  }

  // Check global registry — catches duplicate module instance scenario.
  const existing = _getGlobalClient()
  if (existing !== null) {
    throw new Error(
      '[GTG] configureSupabase() detected a duplicate @gtg/supabase module instance. ' +
      'A Supabase client was already created by a different module instance. ' +
      'This indicates a bundler misconfiguration. ' +
      'Verify that @gtg/supabase resolves to a single path in your bundle.',
    )
  }

  if (!url || !anonKey) {
    throw new Error(
      '[GTG] configureSupabase() requires non-empty url and anonKey. ' +
      'Ensure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are defined ' +
      'in your .env file and are being passed to configureSupabase().',
    )
  }

  const client = createClient<Database>(url, anonKey, {
    auth: {
      // Persist the session in localStorage (browser) or SecureStore (mobile).
      // The adapter is platform-default here; mobile will inject AsyncStorage
      // via a configureSupabase overload in a future phase.
      persistSession: true,
      // Automatically refresh the access token before it expires.
      autoRefreshToken: true,
      // Parse the URL hash for OAuth callback tokens (PKCE flow).
      detectSessionInUrl: true,
    },
  })

  _client = client
  _setGlobalClient(client)
}

// ─── Getter ───────────────────────────────────────────────────────────────────

/**
 * Returns the initialized Supabase client singleton.
 *
 * Safe to call anywhere after configureSupabase() has been called.
 * Multiple calls always return the same instance.
 *
 * If another module instance already created the client (detected via
 * globalThis), that client is adopted and returned — the singleton is
 * recovered without re-initialization.
 *
 * @throws If configureSupabase() has not been called by any module instance.
 *
 * @example
 *   const client = getSupabaseClient()
 *   const { data, error } = await client
 *     .from('serialized_units')
 *     .select('*')
 *     .eq('status', 'available')
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  // Fast path — module-local cache.
  if (_client !== null) return _client

  // Recovery path — another module instance may have configured the client.
  // Adopt it rather than throwing, so duplicate module loads don't break
  // consumers that haven't directly called configureSupabase().
  const global = _getGlobalClient()
  if (global !== null) {
    _client = global
    return _client
  }

  throw new Error(
    '[GTG] getSupabaseClient() called before configureSupabase(). ' +
    'Call configureSupabase(url, anonKey) in your application entry point ' +
    'before making any Supabase calls.',
  )
}

// ─── Predicate ────────────────────────────────────────────────────────────────

/**
 * Returns true if the Supabase client has been initialized.
 *
 * Use this for conditional initialization (e.g., integration test setup)
 * rather than calling configureSupabase() and catching the duplicate error.
 *
 * @example
 *   if (!isSupabaseConfigured()) {
 *     configureSupabase(testUrl, testAnonKey)
 *   }
 */
export function isSupabaseConfigured(): boolean {
  return _client !== null || _getGlobalClient() !== null
}
