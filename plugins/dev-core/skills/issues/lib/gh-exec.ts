import { execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function ghGraphQLExec(query: string, variables?: Record<string, unknown>): unknown {
  const tmpFile = join(tmpdir(), `gh-exec-${Date.now()}.json`)
  writeFileSync(tmpFile, JSON.stringify(variables ? { query, variables } : { query }))
  try {
    const out = execSync(`gh api graphql --input ${tmpFile}`, { encoding: 'utf-8' })
    return JSON.parse(out)
  } finally {
    unlinkSync(tmpFile)
  }
}
