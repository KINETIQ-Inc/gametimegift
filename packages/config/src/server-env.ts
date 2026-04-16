/**
 * @gtg/config/server
 *
 * Server-only environment configuration.
 *
 * Import ONLY from:
 *   - Supabase Edge Functions
 *   - Node.js scripts (royalty report generation, admin CLI tools)
 *   - Server-side middleware (future SSR phase)
 *
 * NEVER import this module in browser bundles. The service role key grants
 * full database access and bypasses all RLS policies. The Stripe secret key
 * enables arbitrary charge creation and refunds.
 *
 * These variables intentionally have NO VITE_ prefix — Vite will never
 * expose them to browser bundles regardless of what is in the .env file.
 * The initEnv() guard in env.ts provides a second line of defense by
 * rejecting any VITE_-prefixed key that matches a server-secret pattern.
 */

import { requireEnv } from './require-env'
import type { EnvSource } from './require-env'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Validated server-side environment configuration.
 *
 * Contains only variables that must never reach the browser.
 * Every field is readonly — the server env contract is immutable
 * after initialization.
 */
export interface ServerEnv {
  /**
   * Supabase service role key.
   *
   * Grants full database access and bypasses all Row Level Security policies.
   * Use only for:
   *   - Admin operations that require cross-user data access
   *   - Royalty report aggregation across all consultant records
   *   - Fraud investigation queries across all ledger entries
   *   - Seeding and migration scripts
   *
   * Never pass this to configureSupabase() — that function is for browser
   * clients using the anon key. Server-side Supabase calls must create their
   * own client with createClient(url, serviceRoleKey).
   */
  readonly supabaseServiceRoleKey: string

  /**
   * Stripe secret key (sk_live_* or sk_test_*).
   *
   * Enables charge creation, refunds, and payout initiation.
   * Used only in Edge Functions and server-side payment handlers.
   */
  readonly stripeSecretKey: string

  /**
   * Stripe webhook signing secret (whsec_*).
   *
   * Used to verify that incoming webhook events originated from Stripe.
   * Required by every webhook handler. Never used client-side.
   */
  readonly stripeWebhookSecret: string
}

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate and parse all required server-only environment variables.
 *
 * Call at the top of every Edge Function handler or server process entry point,
 * before any database or Stripe call.
 *
 * Pass the environment source appropriate for your runtime:
 *
 *   Supabase Edge Functions (Deno):
 *     requireServerEnv(Deno.env.toObject())
 *
 *   Node.js scripts:
 *     requireServerEnv(process.env)
 *
 * @throws If any required server-only variable is missing or empty.
 *
 * @example
 *   // Supabase Edge Function
 *   import { requireServerEnv } from '@gtg/config/server'
 *   import { createClient } from '@supabase/supabase-js'
 *
 *   Deno.serve(async (req) => {
 *     const serverEnv = requireServerEnv(Deno.env.toObject())
 *     const adminClient = createClient(
 *       Deno.env.get('SUPABASE_URL')!,
 *       serverEnv.supabaseServiceRoleKey,
 *     )
 *     // ...
 *   })
 */
export function requireServerEnv(source: EnvSource): ServerEnv {
  return {
    supabaseServiceRoleKey: requireEnv(source, 'SUPABASE_SERVICE_ROLE_KEY'),
    stripeSecretKey:        requireEnv(source, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret:    requireEnv(source, 'STRIPE_WEBHOOK_SECRET'),
  }
}
