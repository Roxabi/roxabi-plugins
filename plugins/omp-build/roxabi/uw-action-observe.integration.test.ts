import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UwActionRequest } from './uw-action-contract.ts'
import { observeCode } from './uw-action-observe.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function mergedFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'omp-observe-merge-'))
  roots.push(cwd)
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim()
  git('init', '-q')
  const tree = git('mktree')
  const base = git('commit-tree', tree, '-m', 'base')
  const head = git('commit-tree', tree, '-p', base, '-m', 'head')
  const merge = git('commit-tree', tree, '-p', base, '-p', head, '-m', 'merge')
  const descendant = git('commit-tree', tree, '-p', merge, '-m', 'later')
  git('update-ref', 'refs/remotes/origin/main', descendant)
  const request: UwActionRequest = {
    actionId: 'review-7',
    purpose: 'review',
    subject: { kind: 'standalone-pr', pullRequest: { repository: 'acme/app', target: 'acme/app#7' } },
    code: { repository: 'acme/app', base, head, referenceCommit: head },
    stageSources: [],
    expandedContext: [],
  }
  const pull = {
    headRefOid: head,
    baseRefOid: descendant,
    headRefName: 'feature',
    baseRefName: 'main',
    state: 'MERGED',
    mergeCommit: { oid: merge },
  }
  const source = { cwd, gh: async () => JSON.stringify(pull) }
  return { git, base, head, merge, request, pull, source }
}

describe('observeCode after a review merge', () => {
  it('accepts the reviewed parents when the merge is contained in the current base', async () => {
    const { request, source } = mergedFixture()
    expect(await observeCode(request, source)).toEqual({ ok: true, value: { branch: 'feature', baseName: 'main' } })
  })

  it('rejects a merge with the wrong first parent', async () => {
    const { git, head, request, pull, source } = mergedFixture()
    const tree = git('mktree')
    const other = git('commit-tree', tree, '-m', 'other')
    const merge = git('commit-tree', tree, '-p', other, '-p', head, '-m', 'wrong merge')
    pull.mergeCommit.oid = merge
    git('update-ref', 'refs/remotes/origin/main', merge)
    expect(await observeCode(request, source)).toMatchObject({ ok: false })
  })

  it('rejects a merge with the wrong second parent', async () => {
    const { git, base, request, pull, source } = mergedFixture()
    const tree = git('mktree')
    const other = git('commit-tree', tree, '-m', 'other')
    const merge = git('commit-tree', tree, '-p', base, '-p', other, '-m', 'wrong merge')
    pull.mergeCommit.oid = merge
    git('update-ref', 'refs/remotes/origin/main', merge)
    expect(await observeCode(request, source)).toMatchObject({ ok: false })
  })

  it('rejects the merged-base exception for non-review purposes', async () => {
    const { request, source } = mergedFixture()
    request.purpose = 'implement'
    expect(await observeCode(request, source)).toMatchObject({ ok: false })
  })

  it('rejects a merge not contained in the current base', async () => {
    const { git, head, request, source } = mergedFixture()
    git('update-ref', 'refs/remotes/origin/main', head)
    expect(await observeCode(request, source)).toMatchObject({ ok: false })
  })
})
