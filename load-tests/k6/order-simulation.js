/**
 * GTG Load Test — Order Simulation (7C-1)
 *
 * Simulates realistic traffic against the GTG Edge Function layer:
 * the full consultant-assisted order lifecycle plus the read-heavy
 * dashboard and public verification paths.
 *
 * ─── Tool ─────────────────────────────────────────────────────────────────────
 *
 *   k6 (https://k6.io) — run with:
 *
 *     k6 run load-tests/k6/order-simulation.js                  # smoke
 *     k6 run --env PROFILE=load  load-tests/k6/order-simulation.js
 *     k6 run --env PROFILE=stress load-tests/k6/order-simulation.js
 *     k6 run --env PROFILE=soak  load-tests/k6/order-simulation.js
 *
 * ─── Prerequisites ────────────────────────────────────────────────────────────
 *
 *   1. Seed test fixtures before running:
 *        node load-tests/helpers/seed.js
 *      This creates the consultant accounts, auth JWTs, and available units
 *      referenced by FIXTURES below.
 *
 *   2. Set the target URL and auth tokens as k6 environment variables:
 *        k6 run --env BASE_URL=https://YOUR_PROJECT.supabase.co \
 *               --env ADMIN_JWT=<admin-jwt> \
 *               --env CONSULTANT_JWT=<consultant-jwt> \
 *               --env CONSULTANT_PROFILE_ID=<uuid> \
 *               load-tests/k6/order-simulation.js
 *
 *      Or export them in your shell before running k6.
 *
 *   3. STRIPE WEBHOOK PATHS ARE NOT LOAD TESTED HERE.
 *      The stripe-webhook handler requires a valid Stripe HMAC signature which
 *      cannot be generated without the live signing secret. Webhook throughput
 *      is covered by the database-level load test (see 7C-2).
 *      Instead, the "order write" scenario tests create-checkout-session, which
 *      exercises reservation logic, consultant lookup, and Stripe session
 *      creation. Use Stripe test mode keys in staging.
 *
 * ─── Scenarios ────────────────────────────────────────────────────────────────
 *
 *   public_verification    verify-serial + get-fraud-warning
 *                          Public, no auth. Highest expected traffic.
 *
 *   consultant_dashboard   get-consultant-units-sold + commission-earned +
 *                          pending-payouts
 *                          Authenticated consultant reads. Sustained baseline.
 *
 *   referral_link          get-referral-link
 *                          Consultant reads their referral URL for sharing.
 *
 *   order_write            create-checkout-session
 *                          Authenticated write. Exercises unit reservation.
 *                          Lower VU count — write paths are naturally throttled
 *                          by Stripe session creation latency.
 *
 * ─── Load profiles ────────────────────────────────────────────────────────────
 *
 *   smoke    2 VUs, 1 min    — confirms all paths return 2xx under minimal load.
 *   load     50 VUs, 10 min  — steady-state production simulation.
 *   stress   150 VUs, 15 min — finds breaking points and queue saturation.
 *   soak     30 VUs, 60 min  — detects memory leaks and connection exhaustion.
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:54321'
const ADMIN_JWT   = __ENV.ADMIN_JWT   || ''
const CONSULTANT_JWT        = __ENV.CONSULTANT_JWT        || ''
const CONSULTANT_PROFILE_ID = __ENV.CONSULTANT_PROFILE_ID || ''

// Serial numbers of sold units pre-seeded for public verification reads.
// These must exist in the test environment (created by seed.js).
const TEST_SERIALS = (__ENV.TEST_SERIALS || 'GTG-CLC-TEST-0001,GTG-CLC-TEST-0002,GTG-CLC-TEST-0003')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ─── Load profiles ────────────────────────────────────────────────────────────

const PROFILES = {
  smoke: {
    scenarios: {
      public_verification: {
        executor: 'constant-vus', vus: 1, duration: '1m',
        exec: 'publicVerification',
      },
      consultant_dashboard: {
        executor: 'constant-vus', vus: 1, duration: '1m',
        exec: 'consultantDashboard',
        startTime: '0s',
      },
    },
    thresholds: {
      http_req_failed:                     ['rate<0.01'],
      http_req_duration:                   ['p(95)<2000'],
      'http_req_duration{scenario:public_verification}': ['p(95)<800'],
      'http_req_duration{scenario:consultant_dashboard}': ['p(95)<1500'],
    },
  },

  load: {
    scenarios: {
      public_verification: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '2m', target: 20 },
          { duration: '6m', target: 20 },
          { duration: '2m', target: 0  },
        ],
        exec: 'publicVerification',
      },
      consultant_dashboard: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '2m', target: 15 },
          { duration: '6m', target: 15 },
          { duration: '2m', target: 0  },
        ],
        exec: 'consultantDashboard',
      },
      referral_link: {
        executor: 'constant-vus', vus: 5, duration: '10m',
        exec: 'referralLink',
      },
      order_write: {
        executor: 'constant-arrival-rate',
        rate: 5,           // 5 checkout sessions per second
        timeUnit: '1s',
        duration: '8m',
        preAllocatedVUs: 10,
        maxVUs: 20,
        startTime: '1m',   // Warm up reads first
        exec: 'orderWrite',
      },
    },
    thresholds: {
      http_req_failed:                                     ['rate<0.01'],
      http_req_duration:                                   ['p(95)<3000'],
      'http_req_duration{scenario:public_verification}':   ['p(95)<1000'],
      'http_req_duration{scenario:consultant_dashboard}':  ['p(95)<2000'],
      'http_req_duration{scenario:order_write}':           ['p(95)<4000'],
      checkout_session_errors:                             ['count<5'],
    },
  },

  stress: {
    scenarios: {
      public_verification: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '3m', target: 50  },
          { duration: '5m', target: 100 },
          { duration: '3m', target: 150 },
          { duration: '2m', target: 0   },
        ],
        exec: 'publicVerification',
      },
      consultant_dashboard: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '3m', target: 20 },
          { duration: '8m', target: 40 },
          { duration: '2m', target: 0  },
        ],
        exec: 'consultantDashboard',
      },
      order_write: {
        executor: 'constant-arrival-rate',
        rate: 15,
        timeUnit: '1s',
        duration: '10m',
        preAllocatedVUs: 20,
        maxVUs: 50,
        startTime: '2m',
        exec: 'orderWrite',
      },
    },
    thresholds: {
      http_req_failed:                                    ['rate<0.05'],
      http_req_duration:                                  ['p(99)<5000'],
      'http_req_duration{scenario:public_verification}':  ['p(99)<2000'],
      checkout_session_errors:                            ['count<50'],
    },
  },

  soak: {
    scenarios: {
      public_verification: {
        executor: 'constant-vus', vus: 10, duration: '60m',
        exec: 'publicVerification',
      },
      consultant_dashboard: {
        executor: 'constant-vus', vus: 10, duration: '60m',
        exec: 'consultantDashboard',
      },
      order_write: {
        executor: 'constant-arrival-rate',
        rate: 3,
        timeUnit: '1s',
        duration: '58m',
        preAllocatedVUs: 10,
        maxVUs: 20,
        startTime: '1m',
        exec: 'orderWrite',
      },
    },
    thresholds: {
      http_req_failed:   ['rate<0.01'],
      http_req_duration: ['p(95)<3000'],
      // Soak-specific: error rate must not climb over time (no memory leak proxy)
      checkout_session_errors: ['count<20'],
    },
  },
}

const PROFILE = PROFILES[__ENV.PROFILE] || PROFILES.smoke

export const options = {
  scenarios:  PROFILE.scenarios,
  thresholds: PROFILE.thresholds,
}

// ─── Custom metrics ───────────────────────────────────────────────────────────

const checkoutSessionErrors   = new Counter('checkout_session_errors')
const verifySerialDuration    = new Trend('verify_serial_duration', true)
const dashboardDuration       = new Trend('dashboard_duration', true)
const checkoutSessionDuration = new Trend('checkout_session_duration', true)
const fraudCheckDuration      = new Trend('fraud_check_duration', true)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function edgeUrl(functionName) {
  return `${BASE_URL}/functions/v1/${functionName}`
}

function postJson(url, body, headers) {
  return http.post(url, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}

function authHeaders(jwt) {
  return { Authorization: `Bearer ${jwt}` }
}

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Normally-distributed sleep between minMs and maxMs. */
function thinkTime(minMs = 500, maxMs = 2000) {
  const ms = minMs + Math.random() * (maxMs - minMs)
  sleep(ms / 1000)
}

// ─── Scenario: Public verification ───────────────────────────────────────────
// Simulates a customer or inspector verifying a unit's authenticity.
// No auth required. This is the highest-frequency public path.

export function publicVerification() {
  const serial = pick(TEST_SERIALS)

  group('verify_serial', () => {
    const start = Date.now()
    const res = postJson(edgeUrl('verify-serial'), { serial_number: serial })
    verifySerialDuration.add(Date.now() - start)

    check(res, {
      'verify-serial: status 200':             (r) => r.status === 200,
      'verify-serial: has data':               (r) => JSON.parse(r.body).data !== undefined,
      'verify-serial: has verification_status':(r) => JSON.parse(r.body).data?.verification_status !== undefined,
      'verify-serial: no error field':         (r) => JSON.parse(r.body).error === undefined,
    })
  })

  thinkTime(200, 800)

  group('get_fraud_warning', () => {
    const start = Date.now()
    const res = postJson(edgeUrl('get-fraud-warning'), { serial_number: serial })
    fraudCheckDuration.add(Date.now() - start)

    check(res, {
      'fraud-warning: status 200':          (r) => r.status === 200,
      'fraud-warning: has warning_level':   (r) => JSON.parse(r.body).data?.warning_level !== undefined,
      'fraud-warning: warning_level valid': (r) => {
        const level = JSON.parse(r.body).data?.warning_level
        return ['none', 'caution', 'alert'].includes(level)
      },
    })
  })

  thinkTime(500, 2000)
}

// ─── Scenario: Consultant dashboard ──────────────────────────────────────────
// Simulates a consultant loading their portal dashboard: all three widgets
// in sequence, as a real page load would trigger them.

export function consultantDashboard() {
  if (!CONSULTANT_JWT) {
    console.warn('CONSULTANT_JWT not set — skipping consultant_dashboard scenario')
    sleep(5)
    return
  }

  const headers    = authHeaders(CONSULTANT_JWT)
  const periodBody = {
    period_start: currentMonthStart(),
    period_end:   today(),
  }

  group('units_sold', () => {
    const start = Date.now()
    const res   = postJson(edgeUrl('get-consultant-units-sold'), periodBody, headers)
    dashboardDuration.add(Date.now() - start)

    check(res, {
      'units-sold: status 200':         (r) => r.status === 200,
      'units-sold: has period_summary': (r) => JSON.parse(r.body).data?.period_summary !== undefined,
      'units-sold: has lifetime':       (r) => JSON.parse(r.body).data?.lifetime !== undefined,
      'units-sold: has recent_orders':  (r) => Array.isArray(JSON.parse(r.body).data?.recent_orders),
    })
  })

  thinkTime(100, 400)

  group('commission_earned', () => {
    const start = Date.now()
    const res   = postJson(edgeUrl('get-consultant-commission-earned'), periodBody, headers)
    dashboardDuration.add(Date.now() - start)

    check(res, {
      'commission-earned: status 200':          (r) => r.status === 200,
      'commission-earned: has period_summary':  (r) => JSON.parse(r.body).data?.period_summary !== undefined,
      'commission-earned: net_cents present':   (r) => JSON.parse(r.body).data?.period_summary?.net_cents !== undefined,
      'commission-earned: has recent_entries':  (r) => Array.isArray(JSON.parse(r.body).data?.recent_entries),
    })
  })

  thinkTime(100, 400)

  group('pending_payouts', () => {
    const res = postJson(edgeUrl('get-consultant-pending-payouts'), {}, headers)

    check(res, {
      'pending-payouts: status 200':                  (r) => r.status === 200,
      'pending-payouts: has pending_payout_cents':    (r) => JSON.parse(r.body).data?.pending_payout_cents !== undefined,
      'pending-payouts: pending_payout_cents numeric':(r) => typeof JSON.parse(r.body).data?.pending_payout_cents === 'number',
      'pending-payouts: has entries array':           (r) => Array.isArray(JSON.parse(r.body).data?.entries),
    })
  })

  thinkTime(1000, 3000)
}

// ─── Scenario: Referral link ──────────────────────────────────────────────────
// Simulates a consultant fetching their referral URL to share with customers.
// Read-only, no mutations.

export function referralLink() {
  if (!CONSULTANT_JWT) {
    sleep(5)
    return
  }

  const res = postJson(
    edgeUrl('get-referral-link'),
    {},
    authHeaders(CONSULTANT_JWT),
  )

  check(res, {
    'referral-link: status 200':        (r) => r.status === 200,
    'referral-link: has referral_url':  (r) => typeof JSON.parse(r.body).data?.referral_url === 'string',
    'referral-link: url not empty':     (r) => JSON.parse(r.body).data?.referral_url?.length > 0,
    'referral-link: has referral_code': (r) => typeof JSON.parse(r.body).data?.referral_code === 'string',
  })

  thinkTime(2000, 5000)
}

// ─── Scenario: Order write (checkout session creation) ───────────────────────
// Simulates a customer creating a checkout session for a unit facilitated
// by a consultant. This is the most expensive write path:
//   - Consultant lookup + eligibility check
//   - Unit availability check + reservation
//   - Stripe API call (CreateSession) — adds ~200–800 ms latency in staging
//
// NOTE: This creates real Stripe test sessions. The reserved units will stay
// reserved until the Stripe session expires (~30 min). Use a test environment
// with many available units (seeded by seed.js) to avoid inventory exhaustion.
// Use Stripe test mode keys; never run against a production Stripe account.

export function orderWrite() {
  if (!CONSULTANT_PROFILE_ID) {
    sleep(5)
    return
  }

  // Simulate a guest customer (no auth JWT) placing an order via a consultant
  // referral link. create-checkout-session does not require auth.
  const body = {
    consultant_id: CONSULTANT_PROFILE_ID,
    // Unit SKU — the function selects an available unit by SKU internally.
    // The seed script must have created available units with this SKU.
    sku:           'APP-NIKE-JERSEY-M',
    customer_name:  randomCustomerName(),
    customer_email: randomEmail(),
    shipping_address: {
      line1:   '123 Test Street',
      city:    'Austin',
      state:   'TX',
      postal_code: '78701',
      country: 'US',
    },
    success_url: 'https://gametimegift.com/order/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url:  'https://gametimegift.com/order/cancel',
  }

  const start = Date.now()
  const res   = postJson(edgeUrl('create-checkout-session'), body)
  checkoutSessionDuration.add(Date.now() - start)

  const ok = check(res, {
    'checkout: status 200':           (r) => r.status === 200,
    'checkout: has checkout_url':     (r) => typeof JSON.parse(r.body).data?.checkout_url === 'string',
    'checkout: has session_id':       (r) => typeof JSON.parse(r.body).data?.session_id === 'string',
    'checkout: no error':             (r) => JSON.parse(r.body).error === undefined,
  })

  if (!ok) {
    checkoutSessionErrors.add(1)
    // Log the first line of the error body for debugging without flooding output.
    const body_str = res.body ? res.body.substring(0, 200) : '(empty)'
    console.error(`checkout-session failed [${res.status}]: ${body_str}`)
  }

  thinkTime(500, 1500)
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function currentMonthStart() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function today() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

// ─── Random data generators ───────────────────────────────────────────────────

const FIRST_NAMES = ['Alex', 'Jordan', 'Morgan', 'Taylor', 'Casey', 'Riley', 'Drew', 'Quinn']
const LAST_NAMES  = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Davis', 'Lee']

function randomCustomerName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`
}

function randomEmail() {
  const rand = Math.random().toString(36).substring(2, 8)
  return `load-test-${rand}@gtg-test.invalid`
}
