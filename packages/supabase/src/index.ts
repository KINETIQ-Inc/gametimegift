// _resetForTesting is intentionally NOT re-exported here.
// It is only reachable via @gtg/supabase/testing.
export { configureSupabase, getSupabaseClient, isSupabaseConfigured } from './client'
export type { Database } from './types'
