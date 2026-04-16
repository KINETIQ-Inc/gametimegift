import { execSync } from 'node:child_process'

function getChangedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF

  const range = baseRef
    ? `origin/${baseRef}...HEAD`
    : 'HEAD~1...HEAD'

  try {
    const output = execSync(`git diff --name-only ${range}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    try {
      // Fallback for shallow/non-standard local environments.
      const output = execSync('git diff --name-only HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      // Last-resort fallback for repos without a resolvable HEAD.
      const output = execSync('git status --porcelain', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
    }
  }
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix))
}

const changedFiles = getChangedFiles()

if (changedFiles.length === 0) {
  console.log('[GTG][critical-gate] No changed files detected. Gate passed.')
  process.exit(0)
}

const changed = new Set(changedFiles)

const touchesApiWrappers = [...changed].some(
  (path) => path.startsWith('packages/api/src/') && path.endsWith('.ts') && !path.includes('/__tests__/'),
)

const touchesEdgeFunctions = [...changed].some(
  (path) => path.startsWith('supabase/functions/') && path.endsWith('.ts') && !path.includes('/test/'),
)

const touchesLedgerPipeline = changed.has('supabase/functions/process-order-ledger/index.ts')

const changedApiTests = [...changed].some((path) => startsWithAny(path, ['packages/api/src/__tests__/']))
const changedEdgeTests = [...changed].some((path) => startsWithAny(path, ['supabase/functions/test/']))
const changedLedgerTests = [...changed].some((path) =>
  [
    'packages/api/src/__tests__/ledger-pipeline.test.ts',
    'supabase/functions/test/ledger-pipeline.test.ts',
  ].includes(path),
)

const failures = []

if (touchesApiWrappers && !changedApiTests) {
  failures.push(
    'API wrappers changed in packages/api/src but no API wrapper tests changed under packages/api/src/__tests__.',
  )
}

if (touchesEdgeFunctions && !changedEdgeTests) {
  failures.push(
    'Edge function code changed in supabase/functions but no edge-function tests changed under supabase/functions/test.',
  )
}

if (touchesLedgerPipeline && !changedLedgerTests) {
  failures.push(
    'Ledger pipeline changed (process-order-ledger) but no ledger pipeline test file was updated.',
  )
}

if (failures.length > 0) {
  console.error('[GTG][critical-gate] FAILED')
  for (const failure of failures) {
    console.error(` - ${failure}`)
  }
  process.exit(1)
}

console.log('[GTG][critical-gate] Passed.')
