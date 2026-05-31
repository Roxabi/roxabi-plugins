import { spawnSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function ghGraphQLExec(query: string, variables?: Record<string, unknown>): unknown {
  const tmpFile = join(tmpdir(), `gh-exec-${Date.now()}.json`)
  const payload = variables && Object.keys(variables).length > 0 ? { query, variables } : { query }
  writeFileSync(tmpFile, JSON.stringify(payload))
  try {
    const proc = spawnSync('gh', ['api', 'graphql', '--input', tmpFile], { encoding: 'utf-8' })
    if (proc.status !== 0) {
      throw new Error(`gh api graphql failed: ${proc.stderr?.trim() ?? `exit ${proc.status}`}`)
    }
    return JSON.parse(proc.stdout)
  } finally {
    unlinkSync(tmpFile)
  }
}
