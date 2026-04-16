/**
 * @gtg/config/testing
 *
 * Test utilities for resetting the env singleton between test runs.
 *
 * Import ONLY from test files. Never import this in application code.
 *
 * Usage (Vitest):
 *
 *   import { resetEnvForTesting } from '@gtg/config/testing'
 *   import { initEnv } from '@gtg/config'
 *
 *   beforeEach(() => {
 *     resetEnvForTesting()
 *     initEnv({
 *       VITE_SUPABASE_URL: 'http://localhost:54321',
 *       VITE_SUPABASE_ANON_KEY: 'test-anon-key',
 *       VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_xxx',
 *       VITE_APP_ENV: 'development',
 *       VITE_LICENSE_CLC_ACTIVE: 'true',
 *       VITE_LICENSE_ARMY_ACTIVE: 'true',
 *       VITE_ROYALTY_RATE_CLC: '0.145',
 *       VITE_HOLOGRAM_VERIFY_BASE_URL: 'http://localhost:9000/verify',
 *       VITE_FRAUD_AUTHORITY_ROLES: 'super_admin,admin',
 *     })
 *   })
 */

import { _resetEnvForTesting } from './env'

/**
 * Reset the env singleton so initEnv() can be called again.
 */
export function resetEnvForTesting(): void {
  _resetEnvForTesting()
}
