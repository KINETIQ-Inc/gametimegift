import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const repoRoot = process.cwd()

function read(filePath) {
  return readFileSync(resolve(repoRoot, filePath), 'utf8')
}

// Pure Node directory walk in place of shelling out to `rg` — GitHub-hosted
// runners don't consistently have ripgrep available, and this validator
// needs to behave identically in local development and CI without depending
// on any external binary. Skips the same kinds of directories `rg --files`
// would have excluded via .gitignore (node_modules, build output, VCS/tool
// dirs) rather than trying to parse .gitignore itself.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.next', '.vercel',
])

function findSourceFiles(root) {
  const results = []

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // root doesn't exist (e.g. apps/mobile is still a placeholder) — skip silently
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(fullPath)
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        results.push(fullPath)
      }
    }
  }

  walk(resolve(repoRoot, root))
  return results
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
const allTs = ['supabase/functions', 'packages', 'apps'].flatMap((root) => findSourceFiles(root))

let tsSource = ''
for (const file of allTs) {
  tsSource += `\n${readFileSync(file, 'utf8')}`
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
