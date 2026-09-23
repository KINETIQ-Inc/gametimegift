import { readdir, readFile } from 'node:fs/promises'

const migrationNames = (await readdir('supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()

if (migrationNames.length === 0) throw new Error('No Supabase migrations found.')

const timestamps = new Set()
for (const name of migrationNames) {
  const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name)
  if (!match) throw new Error(`Invalid migration filename: ${name}`)
  if (timestamps.has(match[1])) throw new Error(`Duplicate migration timestamp: ${match[1]}`)
  timestamps.add(match[1])
}

const workflow = await readFile('.github/workflows/release-production.yml', 'utf8')
const orderedMarkers = [
  'pnpm predeploy:check',
  'supabase db push --dry-run',
  'supabase db push --linked',
  'supabase functions deploy',
  'vercel@59.25.4 deploy --prebuilt --prod --skip-domain',
  'pnpm release:smoke',
  'vercel@59.25.4 promote',
]

let previousIndex = -1
for (const marker of orderedMarkers) {
  const markerIndex = workflow.indexOf(marker)
  if (markerIndex === -1) throw new Error(`Production release workflow is missing: ${marker}`)
  if (markerIndex <= previousIndex) {
    throw new Error(`Production release workflow has an unsafe order near: ${marker}`)
  }
  previousIndex = markerIndex
}

for (const requiredSecret of [
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_ANON_KEY',
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
]) {
  if (!workflow.includes(requiredSecret)) {
    throw new Error(`Production release workflow does not declare ${requiredSecret}.`)
  }
}

for (const configPath of ['vercel.json', 'apps/storefront/vercel.json']) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const deploymentEnabled = config?.git?.deploymentEnabled
  if (deploymentEnabled?.main !== false || deploymentEnabled?.master !== false) {
    throw new Error(`${configPath} must disable automatic main/master deployments.`)
  }
}

console.log(`Release contract valid: ${migrationNames.length} ordered migrations and one controlled deployment path.`)
