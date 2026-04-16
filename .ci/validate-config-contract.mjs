import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const repoRoot = process.cwd()

function read(filePath) {
  return readFileSync(resolve(repoRoot, filePath), 'utf8')
}

function parseEnvExampleKeys(content) {
  const keys = new Set()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/)
    if (match) keys.add(match[1])
  }
  return keys
}

function collectVarsFromPattern(pattern, content) {
  const vars = new Set()
  let match
  while ((match = pattern.exec(content)) !== null) {
    vars.add(match[1])
  }
  return vars
}

function union(...sets) {
  const out = new Set()
  for (const set of sets) {
    for (const item of set) out.add(item)
  }
  return out
}

const envExample = parseEnvExampleKeys(read('.env.example'))
const allTs = execSync("rg --files supabase/functions packages apps -g '*.ts' -g '*.tsx'", {
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

let tsSource = ''
for (const file of allTs) {
  tsSource += `\n${read(file)}`
}

const denoVars = collectVarsFromPattern(/Deno\.env\.get\('([A-Z0-9_]+)'\)/g, tsSource)
const processVars = collectVarsFromPattern(/process\.env\[['\"]([A-Z0-9_]+)['\"]\]/g, tsSource)
const requiredContract = union(denoVars, processVars)

const runtimeProvided = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
])

const optionalRuntimeVars = new Set([
  'LOG_LEVEL',
])

const missingFromEnvExample = [...requiredContract]
  .filter((key) => !runtimeProvided.has(key))
  .filter((key) => !optionalRuntimeVars.has(key))
  .filter((key) => !envExample.has(key))
  .sort()

const exposedBrowserSecrets = [...envExample]
  .filter((key) => key.startsWith('VITE_'))
  .filter((key) => key.includes('SERVICE_ROLE') || key.includes('SECRET_KEY') || key.includes('WEBHOOK_SECRET'))
  .sort()

const failures = []

if (missingFromEnvExample.length > 0) {
  failures.push(
    `Missing from .env.example (required by runtime code): ${missingFromEnvExample.join(', ')}`,
  )
}

if (exposedBrowserSecrets.length > 0) {
  failures.push(
    `Server-only secrets are incorrectly VITE_ prefixed in .env.example: ${exposedBrowserSecrets.join(', ')}`,
  )
}

if (failures.length > 0) {
  console.error('[GTG][config-contract] FAILED')
  for (const failure of failures) {
    console.error(` - ${failure}`)
  }
  process.exit(1)
}

console.log('[GTG][config-contract] Passed.')
console.log(
  `[GTG][config-contract] Checked ${requiredContract.size} runtime vars against ${envExample.size} .env.example vars.`,
)
