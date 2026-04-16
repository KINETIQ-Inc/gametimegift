import { configureSupabase, getSupabaseClient, isSupabaseConfigured } from '@gtg/supabase'
import {
  configureApiTransport,
  type ApiTransportConfig,
  type ApiTransportLogger,
} from './transport'

export interface ApiClientConfig {
  supabaseUrl: string | undefined
  supabaseAnonKey: string | undefined
  retryAttempts?: number
  retryBaseDelayMs?: number
  logger?: ApiTransportLogger | null
}

export interface ApiRuntimeConfig extends ApiTransportConfig {}

export function configureApiClient(config: ApiClientConfig): void {
  const { supabaseUrl, supabaseAnonKey, retryAttempts, retryBaseDelayMs, logger } = config

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      '[GTG] configureApiClient() requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }

  configureApiTransport({ retryAttempts, retryBaseDelayMs, logger })

  if (!isSupabaseConfigured()) {
    configureSupabase(supabaseUrl, supabaseAnonKey)
  }
}

export function configureApiRuntime(config: ApiRuntimeConfig): void {
  configureApiTransport(config)
}

/**
 * Get the configured Supabase client.
 *
 * Use this for auth and session operations (sign in, sign out, getSession,
 * onAuthStateChange) in application code. Do NOT use it for direct table reads
 * or writes — use the domain-specific API functions instead.
 *
 * This re-export exists so application code never needs to import @gtg/supabase
 * directly, preserving the @gtg/api as the single dependency for all data access.
 */
export function getClient() {
  return getSupabaseClient()
}
