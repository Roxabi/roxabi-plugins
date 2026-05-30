import { execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function ghGraphQLExec(query: string): unknown {
  const tmpFile = join(tmpdir(), `gh-exec-${Date.now()}.json`)
  writeFileSync(tmpFile, JSON.stringify({ query }))
  try {
    const out = execSync(`gh api graphql --input ${tmpFile}`, { encoding: 'utf-8' })
    return JSON.parse(out)
  } finally {
    unlinkSync(tmpFile)
  }
}
