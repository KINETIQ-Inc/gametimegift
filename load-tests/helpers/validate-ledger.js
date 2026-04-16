/**
 * GTG Ledger Consistency Validator (7C-2)
 *
 * Runs the full suite of ledger consistency checks against the database
 * by calling run_ledger_consistency_checks() (migration 44).
 *
 * Intended to be run:
 *   (a) immediately after a k6 load test run to confirm no data corruption
 *   (b) as a scheduled post-deploy smoke check in staging/production
 *
 * Usage:
 *   node load-tests/helpers/validate-ledger.js
 *
 *   # After a load test — run against staging:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node load-tests/helpers/validate-ledger.js
 *
 *   # Run individual checks for debugging:
 *   CHECK=validate_consultant_running_totals \
 *   node load-tests/helpers/validate-ledger.js
 *
 * Exit codes:
 *   0   All checks passed
 *   1   One or more checks failed (violations found)
 *   2   Configuration or connection error
 *
 * Required env vars:
 *   SUPABASE_URL              Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY Service role key
 *
 * Optional env vars:
 *   CHECK   Run only the named check function instead of the full suite.
 *           Example: CHECK=validate_ledger_transition_chain
 *   QUIET   Set to 'true' to suppress per-row violation details (summary only).
 */

'use strict'

import { createClient } from '@supabase/supabase-js'

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const SINGLE_CHECK = process.env.CHECK   || null
const QUIET        = process.env.QUIET   === 'true'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
  process.exit(2)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Check definitions ────────────────────────────────────────────────────────
// Each entry maps a check name (as returned by run_ledger_consistency_checks)
// to its individual function name for the --CHECK mode and a description.

const CHECK_META = {
  unit_ledger_status_match: {
    fn:   'validate_unit_ledger_status_match',
    desc: 'Unit status matches latest ledger entry',
    sev:  'critical',  // A mismatch means a partial write occurred mid-transaction.
  },
  sold_units_have_order_lines: {
    fn:   'validate_sold_units_have_order_lines',
    desc: 'Every sold unit has a non-cancelled order line',
    sev:  'critical',
  },
  commission_entry_completeness: {
    fn:   'validate_commission_entry_completeness',
    desc: 'Every consultant order line has a commission entry',
    sev:  'high',
  },
  consultant_running_totals: {
    fn:   'validate_consultant_running_totals',
    desc: 'pending_payout_cents matches sum of earned commission entries',
    sev:  'high',
  },
  lifetime_gte_pending: {
    fn:   'validate_lifetime_commission_totals',
    desc: 'lifetime_commissions_cents >= pending_payout_cents',
    sev:  'high',
  },
  order_financial_totals: {
    fn:   'validate_order_financial_totals',
    desc: 'Order total equals subtotal - discount + shipping + tax',
    sev:  'critical',
  },
  payment_event_idempotency: {
    fn:   'validate_payment_event_idempotency',
    desc: 'No duplicate Stripe event IDs in payment_events',
    sev:  'critical',
  },
  ledger_transition_chain: {
    fn:   'validate_ledger_transition_chain',
    desc: 'Ledger from_status matches previous entry to_status',
    sev:  'high',
  },
  order_line_unit_coverage: {
    fn:   'validate_order_line_unit_coverage',
    desc: 'Order line and unit agree on order_id',
    sev:  'critical',
  },
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m'
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'

const PASS = `${GREEN}✓ PASS${RESET}`
const FAIL = `${RED}✗ FAIL${RESET}`

function pad(str, len) {
  return str.padEnd(len, ' ')
}

function severityColor(sev) {
  return sev === 'critical' ? RED : YELLOW
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now()

  console.log(`\n${BOLD}GTG Ledger Consistency Validator${RESET}`)
  console.log(`${DIM}Target: ${SUPABASE_URL}${RESET}`)
  console.log(`${DIM}Mode:   ${SINGLE_CHECK ? `single check — ${SINGLE_CHECK}` : 'full suite'}${RESET}\n`)

  if (SINGLE_CHECK) {
    await runSingleCheck(SINGLE_CHECK)
  } else {
    await runFullSuite()
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n${DIM}Completed in ${elapsed}s${RESET}\n`)
}

// ─── Full suite via run_ledger_consistency_checks() ───────────────────────────

async function runFullSuite() {
  console.log('Running full suite via run_ledger_consistency_checks()...\n')

  const { data, error } = await admin.rpc('run_ledger_consistency_checks')

  if (error) {
    console.error(`${RED}RPC call failed: ${error.message}${RESET}`)
    console.error('Ensure migration 44 has been applied and the service role has EXECUTE permission.')
    process.exit(2)
  }

  if (!data || data.length === 0) {
    console.error(`${RED}No results returned — unexpected empty response.${RESET}`)
    process.exit(2)
  }

  const COL1 = 36  // check name
  const COL2 = 12  // violations
  const COL3 = 8   // result

  // Header
  console.log(
    `${BOLD}${pad('Check', COL1)}${pad('Violations', COL2)}${pad('Result', COL3)}${RESET}`,
  )
  console.log('─'.repeat(COL1 + COL2 + COL3))

  let failCount = 0

  for (const row of data) {
    const meta   = CHECK_META[row.check_name] ?? { sev: 'high' }
    const status = row.pass ? PASS : FAIL
    const count  = row.violation_count

    console.log(
      `${pad(row.check_name, COL1)}` +
      `${count > 0 ? `${severityColor(meta.sev)}${pad(String(count), COL2)}${RESET}` : pad('0', COL2)}` +
      `${status}`,
    )

    if (!row.pass) {
      failCount++
      if (!QUIET && row.sample_ids) {
        console.log(`  ${DIM}sample IDs: ${row.sample_ids}${RESET}`)
      }
    }
  }

  console.log('─'.repeat(COL1 + COL2 + COL3))

  if (failCount === 0) {
    console.log(`\n${GREEN}${BOLD}All ${data.length} checks passed.${RESET}`)
    process.exit(0)
  } else {
    console.log(
      `\n${RED}${BOLD}${failCount} of ${data.length} checks FAILED.${RESET}`,
    )
    console.log(
      `${DIM}Re-run with CHECK=<name> to inspect violation rows for a specific check.${RESET}`,
    )
    process.exit(1)
  }
}

// ─── Single check mode (verbose row-level output) ─────────────────────────────

async function runSingleCheck(checkName) {
  // The CHECK env var can be either the check_name key or the fn name.
  const meta = CHECK_META[checkName]
    ?? Object.values(CHECK_META).find((m) => m.fn === checkName)

  const fnName = meta?.fn ?? checkName

  console.log(`Running: ${BOLD}${fnName}()${RESET}`)
  if (meta?.desc) console.log(`${DIM}${meta.desc}${RESET}\n`)

  const { data, error } = await admin.rpc(fnName)

  if (error) {
    console.error(`${RED}RPC failed: ${error.message}${RESET}`)
    process.exit(2)
  }

  if (!data || data.length === 0) {
    console.log(`${GREEN}No violations found.${RESET}`)
    process.exit(0)
  }

  console.log(`${RED}${data.length} violation(s) found:${RESET}\n`)

  // Print as a table — show all columns of the returned rows.
  if (data.length > 0) {
    const cols = Object.keys(data[0])
    const widths = cols.map((c) =>
      Math.max(c.length, ...data.map((r) => String(r[c] ?? '').length)),
    )

    // Header
    console.log(cols.map((c, i) => pad(c, widths[i] + 2)).join(''))
    console.log(widths.map((w) => '─'.repeat(w + 2)).join(''))

    // Rows (cap at 50 for readability)
    const rows = data.slice(0, 50)
    for (const row of rows) {
      console.log(cols.map((c, i) => pad(String(row[c] ?? ''), widths[i] + 2)).join(''))
    }

    if (data.length > 50) {
      console.log(`${DIM}... and ${data.length - 50} more rows (truncated)${RESET}`)
    }
  }

  process.exit(1)
}

main().catch((err) => {
  console.error(`\n${RED}Unexpected error: ${err.message}${RESET}`)
  process.exit(2)
})
