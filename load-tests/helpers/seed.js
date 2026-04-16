/**
 * GTG Load Test Seed Script (7C-1)
 *
 * Provisions the fixtures that order-simulation.js depends on:
 *   - A dedicated load-test consultant account (auth user + consultant profile)
 *   - A batch of available serialized units for the test SKU
 *   - Prints the k6 environment variables to set before running the load test
 *
 * Usage:
 *   node load-tests/helpers/seed.js
 *
 * Required env vars (set in .env.local or export in shell):
 *   SUPABASE_URL              Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY Service role key (bypasses RLS)
 *
 * The script is idempotent: running it twice for the same SEED_TAG
 * returns the existing records rather than creating duplicates.
 *
 * WARNING: Never run against a production Supabase project.
 * The SEED_TAG below is embedded in all created records to make
 * cleanup easy — see the teardown() function at the bottom.
 */

'use strict'

import { createClient } from '@supabase/supabase-js'
import * as crypto from 'node:crypto'

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
  process.exit(1)
}

// A stable tag embedded in all test records. Change this to seed a fresh set.
const SEED_TAG = process.env.SEED_TAG || 'load-test-v1'

// SKU used in the order_write scenario. Must exist in the products table.
const TEST_SKU = process.env.TEST_SKU || 'APP-NIKE-JERSEY-M'

// Number of available units to seed for load testing.
// Each create-checkout-session call reserves one unit; size the pool so it
// does not exhaust during the longest load test run (stress: ~15 min, ~5 rps).
// 5 rps × 15 min × 0.5 session expiry overhead ≈ 5000 units recommended.
const UNIT_COUNT = parseInt(process.env.UNIT_COUNT || '500', 10)

// Number of pre-sold units to seed for public verification reads.
const SOLD_UNIT_COUNT = parseInt(process.env.SOLD_UNIT_COUNT || '10', 10)

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGTG Load Test Seed — tag: ${SEED_TAG}`)
  console.log(`Target: ${SUPABASE_URL}\n`)

  const productId = await ensureProduct()
  const { consultantId, consultantAuthUserId } = await ensureConsultant()
  const adminAuthUserId = await ensureAdminUser()
  const soldSerials = await ensureSoldUnits(productId, consultantId, SOLD_UNIT_COUNT)
  await ensureAvailableUnits(productId, UNIT_COUNT)

  const consultantJwt = await mintJwt(consultantAuthUserId, 'consultant')
  const adminJwt      = await mintJwt(adminAuthUserId, 'admin')

  console.log('\n─── k6 Environment Variables ─────────────────────────────────────────────\n')
  console.log(`export BASE_URL="${SUPABASE_URL}"`)
  console.log(`export ADMIN_JWT="${adminJwt}"`)
  console.log(`export CONSULTANT_JWT="${consultantJwt}"`)
  console.log(`export CONSULTANT_PROFILE_ID="${consultantId}"`)
  console.log(`export TEST_SERIALS="${soldSerials.join(',')}"`)
  console.log(`\n# Then run:\n# k6 run --env PROFILE=load load-tests/k6/order-simulation.js\n`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureProduct() {
  const { data, error } = await admin
    .from('products')
    .select('id')
    .eq('sku', TEST_SKU)
    .single()

  if (error || !data) {
    // Product does not exist — create a minimal test product.
    // In a real environment the product catalog is pre-seeded; this handles
    // fresh local stacks only.
    const adminUser = await requireAdminUser()
    const { data: inserted, error: insertErr } = await admin
      .from('products')
      .insert({
        sku:               TEST_SKU,
        name:              'Test Jersey (Load Test)',
        description:       `Seeded by ${SEED_TAG}`,
        license_body:      'CLC',
        royalty_rate:      0.1400,
        cost_cents:        2500,
        retail_price_cents: 4999,
        is_active:         true,
        created_by:        adminUser,
      })
      .select('id')
      .single()

    if (insertErr) throw new Error(`Product insert failed: ${insertErr.message}`)
    console.log(`  product created: ${TEST_SKU} (${inserted.id})`)
    return inserted.id
  }

  console.log(`  product found:   ${TEST_SKU} (${data.id})`)
  return data.id
}

async function ensureConsultant() {
  const email = `${SEED_TAG}-consultant@gtg-load-test.invalid`

  // Look up existing auth user.
  const { data: users } = await admin.auth.admin.listUsers()
  let authUser = users?.users?.find((u) => u.email === email)

  if (!authUser) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password:       crypto.randomBytes(16).toString('hex'),
      email_confirm:  true,
      app_metadata:   { role: 'consultant' },
    })
    if (error) throw new Error(`Auth user create failed: ${error.message}`)
    authUser = created.user
    console.log(`  consultant auth user created: ${email} (${authUser.id})`)
  } else {
    console.log(`  consultant auth user found:   ${email} (${authUser.id})`)
  }

  // Look up existing profile.
  const { data: profile } = await admin
    .from('consultant_profiles')
    .select('id')
    .eq('auth_user_id', authUser.id)
    .single()

  if (profile) {
    console.log(`  consultant profile found: (${profile.id})`)
    return { consultantId: profile.id, consultantAuthUserId: authUser.id }
  }

  // Create profile.
  const { data: created, error: profileErr } = await admin
    .from('consultant_profiles')
    .insert({
      auth_user_id:            authUser.id,
      status:                  'active',
      legal_first_name:        'Load',
      legal_last_name:         'Tester',
      display_name:            `Load Tester (${SEED_TAG})`,
      email,
      commission_tier:         'standard',
      tax_onboarding_complete: true,
    })
    .select('id')
    .single()

  if (profileErr) throw new Error(`Consultant profile create failed: ${profileErr.message}`)
  console.log(`  consultant profile created: (${created.id})`)
  return { consultantId: created.id, consultantAuthUserId: authUser.id }
}

async function ensureAdminUser() {
  const email = `${SEED_TAG}-admin@gtg-load-test.invalid`
  const { data: users } = await admin.auth.admin.listUsers()
  let authUser = users?.users?.find((u) => u.email === email)

  if (!authUser) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password:      crypto.randomBytes(16).toString('hex'),
      email_confirm: true,
      app_metadata:  { role: 'admin' },
    })
    if (error) throw new Error(`Admin auth user create failed: ${error.message}`)
    authUser = created.user
    console.log(`  admin auth user created: ${email} (${authUser.id})`)
  } else {
    console.log(`  admin auth user found:   ${email} (${authUser.id})`)
  }

  return authUser.id
}

async function ensureSoldUnits(productId, consultantId, count) {
  const existing = await admin
    .from('serialized_units')
    .select('serial_number')
    .eq('product_id', productId)
    .eq('status', 'sold')
    .like('serial_number', `GTG-CLC-TEST-%`)
    .limit(count)

  if (existing.data && existing.data.length >= count) {
    const serials = existing.data.map((u) => u.serial_number)
    console.log(`  sold units found: ${serials.length}`)
    return serials
  }

  // Create sold units (status = 'sold'; order_id left null for simplicity —
  // verify-serial and get-fraud-warning only read status, not order linkage).
  const units = Array.from({ length: count }, (_, i) => ({
    serial_number:     `GTG-CLC-TEST-${String(i + 1).padStart(4, '0')}`,
    sku:               TEST_SKU,
    product_id:        productId,
    product_name:      'Test Jersey (Load Test)',
    status:            'sold',
    license_body:      'CLC',
    royalty_rate:      0.1400,
    cost_cents:        2500,
    retail_price_cents: 4999,
    consultant_id:     consultantId,
  }))

  const { error } = await admin
    .from('serialized_units')
    .upsert(units, { onConflict: 'serial_number', ignoreDuplicates: true })

  if (error) throw new Error(`Sold units seed failed: ${error.message}`)

  const serials = units.map((u) => u.serial_number)
  console.log(`  sold units seeded: ${serials.length}`)
  return serials
}

async function ensureAvailableUnits(productId, count) {
  const { count: existing } = await admin
    .from('serialized_units')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
    .eq('status', 'available')
    .like('serial_number', `GTG-CLC-AVAIL-%`)

  if (existing >= count) {
    console.log(`  available units: ${existing} (sufficient)`)
    return
  }

  const needed = count - (existing || 0)
  const offset = existing || 0

  const units = Array.from({ length: needed }, (_, i) => ({
    serial_number:      `GTG-CLC-AVAIL-${String(offset + i + 1).padStart(6, '0')}`,
    sku:                TEST_SKU,
    product_id:         productId,
    product_name:       'Test Jersey (Load Test)',
    status:             'available',
    license_body:       'CLC',
    royalty_rate:       0.1400,
    cost_cents:         2500,
  }))

  // Batch insert in chunks of 200 to stay within Supabase payload limits.
  const CHUNK = 200
  for (let i = 0; i < units.length; i += CHUNK) {
    const chunk = units.slice(i, i + CHUNK)
    const { error } = await admin.from('serialized_units').insert(chunk)
    if (error) throw new Error(`Available units seed failed: ${error.message}`)
    process.stdout.write(`\r  available units seeded: ${Math.min(i + CHUNK, units.length)} / ${units.length}`)
  }
  console.log()
}

async function requireAdminUser() {
  // Returns the first admin or super_admin user id for created_by columns.
  const { data: users } = await admin.auth.admin.listUsers()
  const adminUser = users?.users?.find(
    (u) => ['admin', 'super_admin'].includes(u.app_metadata?.role),
  )
  if (!adminUser) throw new Error('No admin user found. Create one before seeding.')
  return adminUser.id
}

async function mintJwt(userId, role) {
  // Generate a short-lived JWT via Supabase admin API.
  // The token will be valid for the default session duration (~1 hour).
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error || !data?.user) throw new Error(`Failed to get user ${userId}: ${error?.message}`)

  // Exchange for a session token via the admin sign-in API.
  // Note: Supabase doesn't expose a direct "mint JWT" admin endpoint.
  // We generate an OTP link and extract the token from the verification response.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type:  'magiclink',
    email: data.user.email,
  })
  if (linkErr) throw new Error(`Link gen failed for ${role}: ${linkErr.message}`)

  // The link contains the access token as a hash fragment.
  // Parse it from the action_link URL.
  const url         = new URL(linkData.properties.action_link)
  const hashParams  = new URLSearchParams(url.hash.slice(1))
  const accessToken = hashParams.get('access_token')

  if (!accessToken) {
    // Fallback: return the raw link for manual extraction.
    console.warn(`  Could not auto-extract JWT for ${role}. Use this link manually:`)
    console.warn(`  ${linkData.properties.action_link}`)
    return 'MANUAL_EXTRACTION_REQUIRED'
  }

  return accessToken
}

// ─── Teardown (optional) ──────────────────────────────────────────────────────
// Call this to clean up all records created by a previous seed run.

export async function teardown(tag = SEED_TAG) {
  console.log(`\nTearing down seed tag: ${tag}`)
  const email = `${tag}-consultant@gtg-load-test.invalid`

  // Delete available and test units.
  await admin
    .from('serialized_units')
    .delete()
    .like('serial_number', 'GTG-CLC-AVAIL-%')

  await admin
    .from('serialized_units')
    .delete()
    .like('serial_number', 'GTG-CLC-TEST-%')

  // Delete consultant profile (FK cascades to commission_entries if any).
  await admin
    .from('consultant_profiles')
    .delete()
    .like('email', `%${tag}%`)

  // Delete auth users.
  const { data: users } = await admin.auth.admin.listUsers()
  for (const u of (users?.users || [])) {
    if (u.email?.includes(tag)) {
      await admin.auth.admin.deleteUser(u.id)
      console.log(`  deleted auth user: ${u.email}`)
    }
  }

  console.log('Teardown complete.\n')
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message)
  process.exit(1)
})
