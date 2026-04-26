/**
 * @gtg/api — public package surface
 *
 * ─── IMPORT RULE ─────────────────────────────────────────────────────────────
 * App code imports from '@gtg/api' only. Never import from:
 *   '@gtg/supabase'   — data provider; internal to this package
 *   '@gtg/domain'     — business rules; internal to this package
 *   Internal paths    — never import from @gtg/api/src/...
 *
 * ─── FINANCIAL RULE ──────────────────────────────────────────────────────────
 * All financial calculations (commissions, royalties, order totals) execute
 * server-side. App code displays what the API returns; it never computes
 * financial values independently and never bypasses this package to read or
 * write financial tables directly.
 */

// Client / transport / error — the structural layer
export * from './auth'
export * from './client'
export * from './error'
export * from './response'

// Domain modules — ordered alphabetically
export * from './admin'
export * from './bundles'
export * from './campaign'
export * from './commissions'
export * from './consultant'
export * from './customer'
export * from './fraud'
export * from './inventory'
export * from './orders'
export * from './products'
export * from './referrals'
export * from './royalties'
