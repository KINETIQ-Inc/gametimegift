import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const commit = process.env.GITHUB_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error('GITHUB_SHA or VERCEL_GIT_COMMIT_SHA must contain a full 40-character commit SHA.')
}

const outputDirectory = resolve('apps/storefront/public')
const outputPath = resolve(outputDirectory, 'release.json')
const releasedAt = new Date().toISOString()

await mkdir(outputDirectory, { recursive: true })
await writeFile(
  outputPath,
  `${JSON.stringify({ commit: commit.toLowerCase(), released_at: releasedAt }, null, 2)}\n`,
  'utf8',
)

console.log(`Wrote storefront release metadata for ${commit.toLowerCase()}.`)
