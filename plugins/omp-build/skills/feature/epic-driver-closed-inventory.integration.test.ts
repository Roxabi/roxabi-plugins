import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRecord, parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  childNode,
  eventPayloads,
  framedRecords,
  ME,
  prNode,
  RUN,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git, sandbox, sandboxOf, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

const BRANCH = 'feat/2-first-child'

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function successorHistory(old: MandateRecord, current: MandateRecord, kind: 'child' | 'parent'): CanonicalRecord[] {
  const fixtures = roxabiWorkflowFixtures()
  const oldRef = fixtures.mandateRef(old)
  const newRef = fixtures.mandateRef(current)
  const abandonId = 'abandon-old-' + kind
  const selectId = 'select-current-' + kind
  const abandoned = buildRecord({
    version: 1,
    repository: old.repository,
    target: old.target,
    recordId: abandonId,
    runId: old.runId,
    operationId: 'op-' + abandonId,
    kind: 'operator-control',
    payload: { control: 'abandon', controlId: abandonId, mandate: oldRef, predecessor: null },
  })
  const selected = buildRecord({
    version: 1,
    repository: current.repository,
    target: current.target,
    recordId: selectId,
    runId: current.runId,
    operationId: 'op-' + selectId,
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: selectId,
      mandate: newRef,
      predecessor: oldRef,
      successor: newRef,
    },
  })
  if (!abandoned.ok || !selected.ok) throw new Error('invalid ' + kind + ' successor controls')
  return [old, abandoned.value, current, selected.value]
}

function serveOwnership(
  node: { number: number; body: string },
  ownership: 'owned' | 'foreign' | 'unbound' | 'old-parent',
): void {
  const fixtures = roxabiWorkflowFixtures()
  const parentScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: 'o/r#2' }
  const prScope = { repository: 'o/r', target: 'o/r#11' }
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, node.body)
  const parent = fixtures.epicMandate(
    parentScope,
    [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
    { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
  )
  const foreignScope = { repository: 'o/r', target: 'o/r#4' }
  const owner =
    ownership === 'old-parent'
      ? fixtures.epicMandate(
          parentScope,
          [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
          {
            recordId: 'mandate-old-parent',
            operationId: 'op-old-parent',
            body: parentBody,
            ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)),
          },
        )
      : ownership === 'foreign'
        ? fixtures.epicMandate(
            foreignScope,
            [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
            {
              body: parentBody,
              ownSpec: fixtures.ownSpecFromSnapshot(foreignScope, snapshot(foreignScope, parentBody)),
            },
          )
        : parent
  const historical = ownership === 'old-parent' || ownership === 'foreign'
  const child = fixtures.featureMandate(childScope, {
    body: node.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(owner),
    branch: BRANCH,
    runId: 'run00002',
    run: 'run00002',
  })
  const current = historical
    ? fixtures.featureMandate(childScope, {
        recordId: 'mandate-current-child',
        operationId: 'op-current-child',
        body: node.body,
        ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
        parent: fixtures.mandateRef(parent),
        branch: BRANCH,
        runId: 'run00002',
        run: 'run00002',
      })
    : child
  const childRecords = historical ? successorHistory(child, current, 'child') : [child]
  const parentRecords = ownership === 'old-parent' ? successorHistory(owner, parent, 'parent') : [parent]
  const parentHistory = fixtures.historyFrom(parentRecords)
  const ownerHistories = ownership === 'foreign' ? [parentHistory, fixtures.historyFrom([owner])] : [parentHistory]
  const childHistory = fixtures.historyFrom(childRecords, ME, ME, ownerHistories)
  const binding = fixtures.workflowBinding(prScope, child, BRANCH, 'main')
  const prHistory = fixtures.historyFrom([binding], ME, ME, [childHistory, ...ownerHistories])
  if (!historical) {
    expect(
      selectWorkflowBinding({
        pullRequest: prScope,
        histories: [prHistory, childHistory, ...ownerHistories],
        native: { branch: BRANCH, base: 'main' },
      }),
    ).toMatchObject({
      status: 'bound',
      mandate: fixtures.mandateRef(child),
      mandateRecord: { payload: { ownSpec: { uw: childScope }, parent: fixtures.mandateRef(owner) } },
    })
  }
  const comments = fixtures.framedBodies(childRecords, ME, ownerHistories).map((body) => ({ body, author: ME }))
  serveEpic([{ ...node, fixtureComments: comments }], framedRecords(1, parentRecords), { mandate: false })
  if (ownership === 'foreign') serveComments(4, framedRecords(4, [owner]))
  serveComments(
    11,
    ownership === 'unbound'
      ? []
      : fixtures.framedBodies([binding], ME, [childHistory, ...ownerHistories]).map((body) => ({ body, author: ME })),
  )
}

function prepare(
  location: 'legacy' | 'complete' | 'branch-only',
  ownership: 'owned' | 'foreign' | 'unbound' | 'old-parent' = 'owned',
) {
  const { epic, state } = sandbox()
  git(epic, 'switch', '-q', '-c', BRANCH, 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', BRANCH)
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  const closed = prNode(11, BRANCH, tip, { state: 'CLOSED' })
  const node = childNode(2, 'feat(x): first child', { prs: [closed] })
  serveOwnership(node, ownership)
  servePr(11, { state: 'CLOSED', labels: [], autoMerge: false })
  const prFile = path.join(state, 'pr', '11.json')
  const view = JSON.parse(readFileSync(prFile, 'utf8'))
  writeFileSync(prFile, JSON.stringify({ ...view, headRefName: BRANCH, baseRefName: 'main' }))

  // The legacy last:50 view omits the older cross-reference; the complete
  // last:100 view retains it, with both connection page flags explicitly false.
  const epicFile = path.join(state, 'epic.json')
  const epicData = JSON.parse(readFileSync(epicFile, 'utf8'))
  const observed = epicData.data.repository.issue.subIssues.nodes[0]
  observed.closedByPullRequestsReferences.nodes = location === 'legacy' ? [closed] : []
  observed.timelineItems.nodes = []
  writeFileSync(epicFile, JSON.stringify(epicData))
  const containmentFile = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentFile, 'utf8'))
  const issue = containment.data.repository.issue
  issue.closedByPullRequestsReferences.nodes = []
  issue.timelineItems.nodes =
    location === 'branch-only'
      ? []
      : [
          { source: { __typename: 'PullRequest', ...closed } },
          ...Array.from({ length: 59 }, () => ({ source: { __typename: 'Issue' } })),
        ]
  writeFileSync(containmentFile, JSON.stringify(containment))
  return { epic, issue, closed }
}

function expectRecordedStop() {
  const run = drive(['next'])
  expect(run.code, run.stderr).toBe(0)
  expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'branch-mismatch' }])
  expect(eventPayloads(2)).toContainEqual(
    expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'branch-mismatch' }),
  )
  expect(writes().filter((write) => write.startsWith('edit ') || write.startsWith('merge '))).toEqual([])
  expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
}

describe('epic-driver — closed child PR scheduling inventory', () => {
  it('records the closed-branch stop when the legacy view contains the PR', () => {
    prepare('legacy')
    expectRecordedStop()
  })

  it('records the same stop when only the complete issue timeline contains the bound closed PR', () => {
    const { issue, closed } = prepare('complete')
    expect(issue.closedByPullRequestsReferences).toMatchObject({ pageInfo: { hasNextPage: false }, nodes: [] })
    expect(issue.timelineItems.pageInfo.hasPreviousPage).toBe(false)
    expect(issue.timelineItems.nodes).toHaveLength(60)
    expect(issue.timelineItems.nodes[0].source).toMatchObject({ __typename: 'PullRequest', ...closed })
    expectRecordedStop()
  })

  it('records the same stop for a branch-only bound closed PR', () => {
    prepare('branch-only')
    expectRecordedStop()
  })

  for (const ownership of ['unbound', 'foreign', 'old-parent'] as const) {
    it(`refuses a ${ownership} closed PR on the relevant branch without effects`, () => {
      prepare('branch-only', ownership)
      const run = drive(['next'])
      expect(run.code).toBe(2)
      expect(run.stderr).toMatch(/containment PR #11 binding is (absent|incomplete)/)
      expect(writes()).toEqual([])
      expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    })
  }

  it('refuses an edited terminal PR binding without writes or a switch', () => {
    prepare('branch-only')
    const file = path.join(sandboxOf().state, 'comments-11.json')
    const comments = JSON.parse(readFileSync(file, 'utf8'))
    const binding = comments.find((entry: { body: string }) => entry.body.includes('kind=workflow-binding '))
    if (!binding) throw new Error('missing terminal binding fixture')
    binding.updated_at = '2026-10-21T10:00:01Z'
    writeFileSync(file, JSON.stringify(comments))
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toMatch(/bind|edited|history|record/i)
    expect(writes()).toEqual([])
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
  })

  it('ignores an unrelated historical closed PR while resuming the bound current branch', () => {
    const { closed } = prepare('complete')
    const state = sandboxOf().state
    const current = { ...closed, state: 'OPEN' }
    const old = { ...closed, number: 12, headRefName: 'feat/old-unowned' }
    writeFileSync(path.join(state, 'branch-prs-2.json'), JSON.stringify([current]))
    const epicPath = path.join(state, 'epic.json')
    const epicData = JSON.parse(readFileSync(epicPath, 'utf8'))
    epicData.data.repository.issue.subIssues.nodes[0].closedByPullRequestsReferences.nodes = [current]
    writeFileSync(epicPath, JSON.stringify(epicData))
    const containmentPath = path.join(state, 'containment-2.json')
    const containment = JSON.parse(readFileSync(containmentPath, 'utf8'))
    containment.data.repository.issue.timelineItems.nodes = [{ source: { __typename: 'PullRequest', ...old } }]
    writeFileSync(containmentPath, JSON.stringify(containment))
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const run = drive(['next'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ step: { action: 'resume', ticket: 2, branch: BRANCH, pr: { number: 11 } } })
    expect(writes()).toEqual([])
    expect(eventPayloads(2)).not.toContainEqual(expect.objectContaining({ event: 'goal-stop' }))
  })
})
