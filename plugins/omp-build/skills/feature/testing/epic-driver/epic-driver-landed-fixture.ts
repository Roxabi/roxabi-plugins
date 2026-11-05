import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { prNode } from './epic-driver-records.ts'
import { git, sandbox } from './epic-driver-sandbox.ts'

export function landedEpic(files: Record<string, string> = {}): {
  range: string
  merged: Record<string, unknown>
  proof: string
} {
  const { principal, epic, root } = sandbox()
  const proof = path.join(root, 'hook-ran')
  mkdirSync(path.join(principal, 'scripts'))
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), `#!/bin/sh\ntouch '${proof}'\n`)
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
  )
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(principal, name), text)
  const base = git(principal, 'rev-parse', 'HEAD')
  git(principal, 'add', '.')
  git(principal, 'commit', '-qm', 'feat(x): first child (#2)')
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  git(epic, 'fetch', '-q', 'origin')
  if (Object.keys(files).length) git(epic, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
  const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
    state: 'MERGED',
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
  })
  return { range: `${base}..${merge}`, merged, proof }
}
