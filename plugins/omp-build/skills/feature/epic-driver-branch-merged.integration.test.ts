import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  childNode,
  framedRecords,
  ME,
  prNode,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git, sandbox, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

const BRANCH = 'feat/2-first-child'
const parentScope = { repository: 'o/r', target: 'o/r#1' }
const childScope = { repository: 'o/r', target: 'o/r#2' }
const prScope = { repository: 'o/r', target: 'o/r#11' }

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`nonconformant fixture ${scope.target}`)
  return parsed.snapshot
}

function prepare(completedAfterMerge: boolean, autoMerge: boolean) {
  const { epic, state } = sandbox()
  const base = git(epic, 'rev-parse', 'refs/remotes/origin/main')
  git(epic, 'switch', '-q', '-c', BRANCH, base)
  git(epic, 'commit', '-q', '--allow-empty', '-m', 'child work')
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'push', '-q', 'origin', BRANCH)
  git(epic, 'switch', '-q', '--detach', base)
  git(epic, 'merge', '-q', '--no-ff', '-m', 'Merge child', tip)
  const merge = git(epic, 'rev-parse', 'HEAD')
  expect(git(epic, 'rev-parse', `${merge}^1`)).toBe(base)
  expect(git(epic, 'rev-parse', `${merge}^2`)).toBe(tip)
  git(epic, 'switch', '-q', '--detach', base)

  const open = prNode(11, BRANCH, tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: autoMerge ? { enabledAt: '2026-10-21T12:00:00Z' } : null,
  })
  const merged = prNode(11, BRANCH, tip, {
    state: 'MERGED',
    mergedAt: '2026-10-21T12:01:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }, { oid: tip }] } },
  })
  const node = childNode(2, 'feat(x): first child', { prs: [open] })
  const fixtures = roxabiWorkflowFixtures()
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, node.body)
  const parent = fixtures.epicMandate(
    parentScope,
    [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
    { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
  )
  const child = fixtures.featureMandate(childScope, {
    body: node.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(parent),
    branch: BRANCH,
    runId: 'run00002',
    run: 'run00002',
  })
  const parentHistory = fixtures.historyFrom([parent])
  const childHistory = fixtures.historyFrom([child], ME, ME, [parentHistory])
  const binding = fixtures.workflowBinding(prScope, child, BRANCH, 'main')
  const prHistory = fixtures.historyFrom([binding], ME, ME, [childHistory, parentHistory])
  expect(
    selectWorkflowBinding({
      pullRequest: prScope,
      histories: [prHistory, childHistory, parentHistory],
      native: { branch: BRANCH, base: 'main' },
    }),
  ).toMatchObject({
    status: 'bound',
    mandate: fixtures.mandateRef(child),
    mandateRecord: { payload: { ownSpec: { uw: childScope }, parent: fixtures.mandateRef(parent) } },
  })
  const comments = fixtures.framedBodies([child], ME, [parentHistory]).map((body) => ({ body, author: ME }))
  serveEpic([{ ...node, fixtureComments: comments }], framedRecords(1, [parent]), { mandate: false })
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
  servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge })
  const viewPath = path.join(state, 'pr', '11.json')
  writeFileSync(
    viewPath,
    JSON.stringify({ ...JSON.parse(readFileSync(viewPath, 'utf8')), headRefName: BRANCH, baseRefName: 'main' }),
  )

  // The PR is discovered exclusively by its authenticated branch, never by issue references.
  const epicPath = path.join(state, 'epic.json')
  const epicData = JSON.parse(readFileSync(epicPath, 'utf8'))
  const observed = epicData.data.repository.issue.subIssues.nodes[0]
  observed.closedByPullRequestsReferences.nodes = []
  observed.timelineItems.nodes = []
  writeFileSync(epicPath, JSON.stringify(epicData))
  const containmentPath = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentPath, 'utf8'))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = []
  containment.data.repository.issue.timelineItems.nodes = []
  writeFileSync(containmentPath, JSON.stringify(containment))
  writeFileSync(path.join(state, 'branch-prs-2.json.after-edit'), JSON.stringify([merged]))
  writeFileSync(path.join(state, 'pr', '11.merge-on-edit.json'), JSON.stringify(merged))
  if (completedAfterMerge) {
    observed.state = 'CLOSED'
    observed.stateReason = 'COMPLETED'
    writeFileSync(`${epicPath}.2`, JSON.stringify(epicData))
    const uwPath = path.join(state, 'uw-2.json')
    const uw = JSON.parse(readFileSync(uwPath, 'utf8'))
    uw.data.repository.issue.state = 'CLOSED'
    uw.data.repository.issue.stateReason = 'COMPLETED'
    writeFileSync(`${uwPath}.after-edit`, JSON.stringify(uw))
  }
  return { state, merge, tip, base }
}

describe('epic-driver — branch-only PR merged during disarm', () => {
  it.each([false, true])('does not silently resume PR-free when the child remains open (autoMerge=%s)', (autoMerge) => {
    const { state, merge, tip, base } = prepare(false, autoMerge)
    const run = drive(['next'])
    expect(writes()).toContain('edit 11 --remove-label reviewed')
    expect(JSON.parse(readFileSync(path.join(state, 'pr', '11.native.json'), 'utf8'))).toMatchObject({
      number: 11,
      state: 'MERGED',
      headRefOid: tip,
      mergedAt: '2026-10-21T12:01:00Z',
      mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }, { oid: tip }] } },
    })
    if (run.code === 0) {
      expect(run.json().step).toMatchObject({ action: 'final-review', stage: 'review' })
    } else {
      expect(run.code, run.stderr || run.stdout).toBe(2)
      expect(run.stderr).toMatch(/(?:PR\s*#?11|#11)/i)
      expect(run.stderr).toMatch(/merge|conflict|inconsisten|changed/i)
    }
  })

  it('requires final review when the independently valid child completes at the merge', () => {
    const { state, merge } = prepare(true, false)
    const run = drive(['next'])
    expect(writes()).toContain('edit 11 --remove-label reviewed')
    expect(JSON.parse(readFileSync(path.join(state, 'pr', '11.native.json'), 'utf8'))).toMatchObject({
      number: 11,
      state: 'MERGED',
      mergeCommit: { oid: merge },
    })
    expect(run.code, run.stderr).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'final-review', stage: 'review' })
  })
})
