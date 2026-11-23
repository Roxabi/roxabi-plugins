import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { inheritedParentSpecs } from './testing/epic-driver/epic-driver-parent-vector.ts'
import {
  childNode,
  epicEvent,
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
import {
  cleanupSandbox,
  disarmControlTarget,
  git,
  readControlTarget,
  sandbox,
  sandboxOf,
  writes,
} from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

const BRANCH = 'feat/2-first-child'

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function prepareBranchOnly(stopped = false, prState: 'OPEN' | 'CLOSED' = 'OPEN') {
  const { epic, state } = sandbox()
  git(epic, 'switch', '-q', '-c', BRANCH, 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', BRANCH)
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  const candidate = prNode(11, BRANCH, tip, {
    state: prState,
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: prState === 'OPEN' ? { enabledAt: 'x' } : null,
  })
  const node = childNode(2, 'feat(x): first child', { prs: [candidate] })
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
  const child = fixtures.featureMandate(childScope, {
    body: node.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(parent),
    inheritedOwnSpecRefs: inheritedParentSpecs(parent),
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
  if (stopped)
    comments.push(
      ...framedRecords(2, [
        epicEvent(2, 'existing-stop', {
          event: 'goal-stop',
          run: RUN,
          reason: 'timeout',
          detail: 'previous timeout',
        }),
      ]),
    )
  serveEpic([{ ...node, fixtureComments: comments }], framedRecords(1, [parent]))
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
  servePr(11, { state: prState, labels: ['reviewed'], autoMerge: prState === 'OPEN' })
  const prFile = path.join(state, 'pr', '11.json')
  const view = JSON.parse(readFileSync(prFile, 'utf8'))
  writeFileSync(prFile, JSON.stringify({ ...view, headRefName: BRANCH, baseRefName: 'main' }))

  // Remove only issue-to-PR hints; leave the complete branch query's candidate intact.
  const containmentFile = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentFile, 'utf8'))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = []
  containment.data.repository.issue.timelineItems.nodes = []
  writeFileSync(containmentFile, JSON.stringify(containment))
  expect(JSON.parse(readFileSync(path.join(state, 'branch-prs-2.json'), 'utf8'))).toEqual([candidate])
  return fixtures.mandateRef(parent)
}

describe('epic control — branch-only child PR inventory', () => {
  it.each([false, true])('discovers a branch-only child PR with prior stop: %s', (stopped) => {
    prepareBranchOnly(stopped)
    const history = eventPayloads(2)
    expect(history).toEqual(
      stopped ? [expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'timeout' })] : [],
    )
    const run = readControlTarget()
    expect(run.code, run.stderr).toBe(0)
    expect(run.json().openPrs).toEqual([{ ticket: 2, pr: 11 }])
    expect(writes()).toEqual([])
  })

  it('discovers a closed but unmerged branch-only PR', () => {
    prepareBranchOnly(false, 'CLOSED')
    const run = readControlTarget()
    expect(run.code, run.stderr).toBe(0)
    expect(run.json().openPrs).toEqual([{ ticket: 2, pr: 11 }])
    expect(writes()).toEqual([])
  })

  it('withdraws authorization and auto-merge from the stopped child through parent containment', () => {
    const mandate = prepareBranchOnly(true)
    const history = eventPayloads(2)
    const run = disarmControlTarget(mandate)
    expect(run.code, run.stderr).toBe(0)
    const result = run.json()
    expect(result, JSON.stringify(result)).toMatchObject({ clean: true })
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr).toMatchObject({ state: 'OPEN', labels: [], autoMergeRequest: null })
    expect(writes()).toEqual([
      'comment 11 <!-- kit-head-authorization:v1 -->',
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
    ])
    expect(eventPayloads(2)).toEqual(history)
  })

  it('does not claim clean containment when head authorization withdrawal is forbidden', () => {
    const mandate = prepareBranchOnly(true)
    writeFileSync(path.join(sandboxOf().state, 'withdraw-forbidden'), '')
    const run = disarmControlTarget(mandate)
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({
      clean: false,
      evidence: { disarmed: [{ pr: 11, error: 'authorization write not confirmed' }] },
    })
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(writes()).toEqual([])
  })
})
