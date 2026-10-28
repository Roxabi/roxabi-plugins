import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serveBoundEpic } from './testing/epic-driver/epic-driver-bound-fixture.ts'
import { childNode, prNode, servePr } from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git, sandbox, sandboxOf, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

describe('epic-driver — eventual consistency', () => {
  const reads = () => Number(readFileSync(path.join(sandboxOf().state, 'reads'), 'utf8'))

  function armedOnOrigin(autoMerge = false, sticky = false): string {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    const armed = {
      labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
      autoMergeRequest: autoMerge ? { enabledAt: 'x' } : null,
    }
    serveBoundEpic(
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] }),
      11,
      'feat/2-first-child',
    )
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge }, sticky)
    return tip
  }

  it.each([false, true])(
    'reads GitHub once more when the PR merged during its disarm (autoMerge=%s), and moves on',
    (autoMerge) => {
      const tip = armedOnOrigin(autoMerge)
      const { state } = sandboxOf()
      const initial = new Map(
        ['containment-2', 'branch-prs-2', 'uw-2'].map((name) => [name, readFileSync(path.join(state, `${name}.json`))]),
      )
      const merged = prNode(11, 'feat/2-first-child', tip, {
        state: 'MERGED',
        mergedAt: '2026-09-30T10:00:00Z',
        mergeCommit: { oid: 'd'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } },
      })
      // The first read is the stale one; every later read shows the merge.
      writeFileSync(path.join(state, 'epic.json.1'), readFileSync(path.join(state, 'epic.json')))
      serveBoundEpic(
        childNode(2, 'feat(x): first child', { state: 'CLOSED', stateReason: 'COMPLETED', prs: [merged] }),
        11,
        'feat/2-first-child',
      )
      for (const [name, contents] of initial) {
        const current = path.join(state, `${name}.json`)
        writeFileSync(`${current}.after-edit`, readFileSync(current))
        writeFileSync(current, contents)
      }
      writeFileSync(path.join(state, 'pr', '11.merge-on-edit.json'), JSON.stringify(merged))

      const run = drive(['next'])

      expect(run.code, run.stderr).toBe(0)
      expect(run.json().step).toMatchObject({ action: 'final-review', stage: 'review' })
      expect(reads()).toBeGreaterThanOrEqual(2)
      expect(writes()).toEqual(
        expect.arrayContaining([...(autoMerge ? ['merge 11 --disable-auto'] : []), 'edit 11 --remove-label reviewed']),
      )
    },
  )

  it.each([false, true])('stops after exactly one re-read when the facts stay stale (autoMerge=%s)', (autoMerge) => {
    const tip = armedOnOrigin(autoMerge)
    const { state } = sandboxOf()
    const merged = prNode(11, 'feat/2-first-child', tip, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: 'd'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } },
    })
    writeFileSync(path.join(state, 'pr', '11.merge-on-edit.json'), JSON.stringify(merged))

    const run = drive(['next'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain('merged, yet the facts still show it open')
    expect(reads()).toBe(2)
    expect(writes()).toEqual([...(autoMerge ? ['merge 11 --disable-auto'] : []), 'edit 11 --remove-label reviewed'])
  })

  it.each([false, true])('preserves a disarm failure while the PR stays open and armed (autoMerge=%s)', (autoMerge) => {
    armedOnOrigin(autoMerge, true)

    const run = drive(['next'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain(autoMerge ? 'stays armed' : 'still armed after the disarm')
    expect(reads()).toBe(1)
    expect(writes()).toEqual([...(autoMerge ? ['merge 11 --disable-auto'] : []), 'edit 11 --remove-label reviewed'])
  })

  it('refuses a stale open hint when fresh native PR metadata says merged', () => {
    const tip = armedOnOrigin()
    const { state } = sandboxOf()
    const containmentPath = path.join(state, 'containment-2.json')
    const containment = JSON.parse(readFileSync(containmentPath, 'utf8'))
    containment.data.repository.issue.closedByPullRequestsReferences.nodes = []
    writeFileSync(containmentPath, JSON.stringify(containment))
    writeFileSync(path.join(state, 'branch-prs-2.json'), '[]')
    const merged = prNode(11, 'feat/2-first-child', tip, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: 'd'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } },
    })
    writeFileSync(path.join(state, 'pr', '11.native.json'), JSON.stringify(merged))

    const run = drive(['next'])

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('containment PR #11 has conflicting observations')
    expect(writes()).toEqual([])
  })
})
