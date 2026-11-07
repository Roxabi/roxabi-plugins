import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { sandboxOf } from './epic-driver-sandbox.ts'

const authorizationCore = createRequire(import.meta.url)('../../../../vendor/kit-head-authorization/index.cjs') as {
  render: (record: Record<string, unknown>) => string
}

export function seedAuthorization(pr: number, head: string): void {
  const file = path.join(sandboxOf().state, `comments-${pr}.json`)
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  const id = 900000 + pr
  const body = authorizationCore.render({
    version: 1,
    kind: 'grant',
    operationId: `fixture-grant-${pr}`,
    repositoryId: 1,
    pullRequestId: 1000 + pr,
    pullRequest: pr,
    headSha: head,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    lane: 'reviewed',
    source: 'native',
    previous: null,
    evidence: 'fixture-review',
  })
  rows.push({
    id,
    node_id: `IC_${id}`,
    body,
    user: { login: 'operator', id: 101, type: 'User' },
    performed_via_github_app: null,
    created_at: '2026-10-21T10:00:00Z',
    updated_at: '2026-10-21T10:00:00Z',
  })
  writeFileSync(file, JSON.stringify(rows))
}
