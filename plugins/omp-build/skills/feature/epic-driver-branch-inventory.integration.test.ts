import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
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
import { cleanupSandbox, drive, git, sandbox, sandboxOf, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

const BRANCH = 'feat/2-first-child'

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function prepareBranchOnly(stopped = false): void {
  const { epic, state } = sandbox()
  git(epic, 'switch', '-q', '-c', BRANCH, 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', BRANCH)
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  const candidate = prNode(11, BRANCH, tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: { enabledAt: 'x' },
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
  serveEpic([{ ...node, fixtureComments: comments }], framedRecords(1, [parent]), { mandate: false })
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
  servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
  const prFile = path.join(state, 'pr', '11.json')
  const view = JSON.parse(readFileSync(prFile, 'utf8'))
  writeFileSync(prFile, JSON.stringify({ ...view, headRefName: BRANCH, baseRefName: 'main' }))

  // Remove only issue-to-PR hints; leave the complete branch query's candidate intact.
  const epicFile = path.join(state, 'epic.json')
  const epicData = JSON.parse(readFileSync(epicFile, 'utf8'))
  const observed = epicData.data.repository.issue.subIssues.nodes[0]
  observed.closedByPullRequestsReferences.nodes = []
  observed.timelineItems.nodes = []
  writeFileSync(epicFile, JSON.stringify(epicData))
  const containmentFile = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentFile, 'utf8'))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = []
  containment.data.repository.issue.timelineItems.nodes = []
  writeFileSync(containmentFile, JSON.stringify(containment))
  expect(JSON.parse(readFileSync(path.join(state, 'branch-prs-2.json'), 'utf8'))).toEqual([candidate])
}

function expectDisarmed(): void {
  const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
  expect(pr).toMatchObject({ state: 'OPEN', labels: [], autoMergeRequest: null })
  expect(writes()).toEqual(expect.arrayContaining(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed']))
}

function stops() {
  return eventPayloads(2).filter((event) => event.event === 'goal-stop')
}

describe('epic-driver — branch-only child PR inventory', () => {
  it('disarms the owned branch-only PR before publishing an explicit stop', () => {
    prepareBranchOnly()
    expect(stops()).toEqual([])
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ ticket: 2, stop: 'timeout', disarmed: { 11: 'disarmed' } })
    expectDisarmed()
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(stops()).toEqual([expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'timeout' })])
  })

  it('reconciles a stopped child’s owned branch-only armed PR', () => {
    prepareBranchOnly(true)
    const before = stops()
    expect(before).toEqual([expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'timeout' })])
    const run = drive(['next'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json().reconciled).toEqual([{ ticket: 2, pr: 11, disarmed: 'disarmed' }])
    expectDisarmed()
    expect(writes()).toEqual(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed'])
    expect(stops()).toEqual(before)
  })

  it('disarms the owned branch-only PR before resuming its branch', () => {
    prepareBranchOnly()
    const run = drive(['next'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({
      step: { action: 'resume', ticket: 2, branch: BRANCH },
      disarmed: 'disarmed',
      reconciled: [],
    })
    expectDisarmed()
    expect(writes()).toEqual(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed'])
    expect(stops()).toEqual([])
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe(BRANCH)
  })

  it('control-disarm discovers and contains the same branch-only candidate', () => {
    prepareBranchOnly()
    const run = drive(['control-disarm'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ failed: [], disarmed: { 11: 'disarmed' } })
    expectDisarmed()
    expect(writes()).toEqual(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed'])
    expect(stops()).toEqual([])
  })

  it('starts a genuinely new child without requiring a PR binding', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(['next'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ step: { action: 'start', ticket: 2 }, disarmed: null, reconciled: [] })
    expect(writes()).toEqual([])
    expect(stops()).toEqual([])
  })
})
