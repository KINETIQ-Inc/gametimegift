import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appPath = resolve(process.cwd(), 'src', 'App.tsx')
const source = readFileSync(appPath, 'utf8')

const hrefTargets = new Set()
const idTargets = new Set()

const hrefPattern = /href=["']#([A-Za-z0-9_-]+)["']/g
const idPattern = /id=["']([A-Za-z0-9_-]+)["']/g

let match
while ((match = hrefPattern.exec(source)) !== null) {
  hrefTargets.add(match[1])
}
while ((match = idPattern.exec(source)) !== null) {
  idTargets.add(match[1])
}

const missing = [...hrefTargets].filter((target) => !idTargets.has(target))

if (missing.length > 0) {
  console.error(
    `[GTG][smoke] Broken in-page anchor(s) in App.tsx: ${missing.map((id) => `#${id}`).join(', ')}`,
  )
  process.exit(1)
}

console.log(`[GTG][smoke] In-page anchor check passed (${hrefTargets.size} anchor target(s)).`)
