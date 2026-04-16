/**
 * @gtg/supabase/testing
 *
 * Test utilities for resetting the Supabase singleton between test runs.
 *
 * Import ONLY from test files. Never import this in application code —
 * it bypasses singleton enforcement by design.
 *
 * Usage (Vitest):
 *
 *   import { resetSupabaseForTesting } from '@gtg/supabase/testing'
 *
 *   beforeEach(() => {
 *     resetSupabaseForTesting()
 *   })
 *
 * After calling this, configureSupabase() can be called again to inject
 * test credentials (e.g., a local Supabase instance or a mock URL).
 *
 * Warning: any SupabaseClient references held by components or hooks prior
 * to reset still point to the old client. Unmount all components before
 * calling resetSupabaseForTesting() to avoid state leaks between tests.
 */

import { _resetForTesting } from './client'

/**
 * Reset the Supabase singleton.
 *
 * Clears both the module-local client cache and the globalThis registry.
 * After this call, configureSupabase() may be called again.
 *
 * @example
 *   beforeEach(() => {
 *     resetSupabaseForTesting()
 *     configureSupabase('http://localhost:54321', 'test-anon-key')
 *   })
 */
export function resetSupabaseForTesting(): void {
  _resetForTesting()
}
