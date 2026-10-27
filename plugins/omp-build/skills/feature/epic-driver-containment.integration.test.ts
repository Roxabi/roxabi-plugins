import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  childNode,
  epicDecisionHistory,
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

type Change = 'wayfinder' | 'removed'
function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function prepareArmedChild(change: Change | 'none', foreignParent = false): void {
  const { epic, state } = sandbox()
  git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
  const armed = prNode(11, 'feat/2-first-child', tip, {
    labels: { nodes: [{ name: 'reviewed' }] },
    autoMergeRequest: { enabledAt: 'x' },
  })
  const fixtures = roxabiWorkflowFixtures()
  const parentScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: 'o/r#2' }
  const prScope = { repository: 'o/r', target: 'o/r#11' }
  const node = childNode(2, 'feat(x): first child', { prs: [armed] })
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, node.body)
  const parent = fixtures.epicMandate(
    parentScope,
    [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
    { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
  )
  const otherScope = { repository: 'o/r', target: 'o/r#4' }
  const owner = foreignParent
    ? fixtures.epicMandate(
        otherScope,
        [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
        { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(otherScope, snapshot(otherScope, parentBody)) },
      )
    : parent
  const childMandate = fixtures.featureMandate(childScope, {
    body: node.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(owner),
    branch: 'feat/2-first-child',
    runId: 'run00002',
    run: 'run00002',
  })
  const parentHistory = fixtures.historyFrom([owner])
  const childHistory = fixtures.historyFrom([childMandate], ME, ME, [parentHistory])
  const binding = fixtures.workflowBinding(prScope, childMandate, 'feat/2-first-child', 'main')
  const prHistory = fixtures.historyFrom([binding], ME, ME, [childHistory, parentHistory])
  const selected = selectWorkflowBinding({
    pullRequest: prScope,
    histories: [prHistory, childHistory, parentHistory],
    native: { branch: 'feat/2-first-child', base: 'main' },
  })
  expect(selected).toMatchObject({
    status: 'bound',
    mandate: fixtures.mandateRef(childMandate),
    mandateRecord: { payload: { ownSpec: { uw: childScope }, parent: fixtures.mandateRef(owner) } },
  })
  serveEpic(
    [
      {
        ...node,
        fixtureComments: fixtures
          .framedBodies([childMandate], ME, [parentHistory])
          .map((body) => ({ body, author: ME })),
      },
    ],
    framedRecords(1, [parent]),
    { mandate: false },
  )
  if (foreignParent) serveComments(4, framedRecords(4, [owner]))
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
  servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
  const childPath = path.join(state, 'uw-2.json')
  const child = JSON.parse(readFileSync(childPath, 'utf8'))
  if (change === 'wayfinder') {
    child.data.repository.issue.labels.nodes.push({ name: 'wayfinder:map' })
  } else if (change === 'removed') {
    child.data.repository.issue.parent = null
    const parentPath = path.join(state, 'uw-1.json')
    const parent = JSON.parse(readFileSync(parentPath, 'utf8'))
    parent.data.repository.issue.subIssues.nodes = []
    writeFileSync(parentPath, JSON.stringify(parent))
    const dashboardPath = path.join(state, 'epic.json')
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf8'))
    dashboard.data.repository.issue.subIssues.nodes = []
    writeFileSync(dashboardPath, JSON.stringify(dashboard))
  }
  writeFileSync(childPath, JSON.stringify(child))
}

function clearIssuePrLinks(): void {
  const file = path.join(sandboxOf().state, 'containment-2.json')
  const issue = JSON.parse(readFileSync(file, 'utf8'))
  issue.data.repository.issue.closedByPullRequestsReferences.nodes = []
  issue.data.repository.issue.timelineItems.nodes = []
  writeFileSync(file, JSON.stringify(issue))
}

function expectDisarmed(): void {
  const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
  expect(pr.autoMergeRequest).toBeNull()
  expect(pr.labels).toEqual([])
  expect(writes()).toEqual(expect.arrayContaining(['merge 11 --disable-auto', 'edit 11 --remove-label reviewed']))
}

describe('epic-driver — accepted child containment after topology drift', () => {
  it('control-disarm contains the bound child when topology is unchanged', () => {
    prepareArmedChild('none')
    const run = drive(['control-disarm'])
    expect(run.code, run.stderr).toBe(0)
    expectDisarmed()
    expect(run.json()).toMatchObject({ failed: [] })
  })

  it.each(['control', 'drop'])('%s does not disarm a candidate bound to a different parent mandate', (action) => {
    prepareArmedChild('none', true)
    const run = drive(
      action === 'control' ? ['control-disarm'] : ['report', '--outcome', 'drop', '--reason', 'driver-error'],
    )
    expect(run.code !== 0 || (action === 'control' && run.json().failed.length > 0)).toBe(true)
    expect(writes()).toEqual([])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
  })

  it.each(['control', 'drop'])(
    '%s does not claim clean containment when an accepted removed child is inaccessible',
    (action) => {
      prepareArmedChild('removed')
      unlinkSync(path.join(sandboxOf().state, 'uw-2.json'))
      const run = drive(
        action === 'control' ? ['control-disarm'] : ['report', '--outcome', 'drop', '--reason', 'driver-error'],
      )
      expect(run.code !== 0 || (action === 'control' && run.json().failed.length > 0)).toBe(true)
      expect(writes()).toEqual([])
    },
  )

  it.each<{ action: 'control' | 'drop'; change: Change }>([
    { action: 'control', change: 'wayfinder' },
    { action: 'control', change: 'removed' },
    { action: 'drop', change: 'wayfinder' },
    { action: 'drop', change: 'removed' },
  ])('$action recovers a bound $change child PR without issue links', ({ action, change }) => {
    prepareArmedChild(change)
    clearIssuePrLinks()
    const run = drive(
      action === 'control' ? ['control-disarm'] : ['report', '--outcome', 'drop', '--reason', 'driver-error'],
    )
    expect(run.code, run.stderr).toBe(0)
    expectDisarmed()
  })

  it.each(['control', 'drop'])('%s remains unconfirmed when branch discovery is unavailable', (action) => {
    prepareArmedChild('removed')
    clearIssuePrLinks()
    writeFileSync(path.join(sandboxOf().state, 'branch-unavailable'), '')
    const run = drive(
      action === 'control' ? ['control-disarm'] : ['report', '--outcome', 'drop', '--reason', 'driver-error'],
    )
    expect(run.code).not.toBe(0)
    expect(writes()).toEqual([])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
  })

  it.each<Change>(['wayfinder', 'removed'])('control-disarm contains the accepted %s child', (change) => {
    prepareArmedChild(change)
    const run = drive(['control-disarm'])
    expect(run.code, run.stderr).toBe(0)
    expectDisarmed()
    expect(run.json()).toMatchObject({ failed: [] })
  })

  it.each<Change>(['wayfinder', 'removed'])('drop contains the accepted %s child before reporting', (change) => {
    prepareArmedChild(change)
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code, run.stderr).toBe(0)
    expectDisarmed()
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', outcome: 'drop', run: RUN }),
    )
  })
})

function prepareFinalReview(blocking: boolean): string {
  const { principal, epic, state } = sandbox()
  const base = git(principal, 'rev-parse', 'HEAD')
  writeFileSync(path.join(principal, 'delivered.txt'), 'delivered\n')
  git(principal, 'add', '.')
  git(principal, 'commit', '-qm', 'feat(x): first child (#2)')
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  git(epic, 'fetch', '-q', 'origin')
  const range = `${base}..${merge}`
  const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
    state: 'MERGED',
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
  })
  serveEpic([childNode(3, 'fix(y): independent blocker')])
  const blockerPath = path.join(state, 'uw-3.json')
  const blocker = JSON.parse(readFileSync(blockerPath, 'utf8'))
  blocker.data.repository.issue.parent = null
  writeFileSync(blockerPath, JSON.stringify(blocker))
  const history = epicDecisionHistory(range, blocking)
  serveEpic(
    [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
    blocking ? history : history.slice(0, -1),
  )
  return range
}

function changeParent(change: 'blocker' | 'tier'): void {
  const file = path.join(sandboxOf().state, 'uw-1.json')
  const parent = JSON.parse(readFileSync(file, 'utf8'))
  if (change === 'blocker')
    parent.data.repository.issue.blockedBy.nodes = [{ number: 3, repository: { nameWithOwner: 'o/r' } }]
  else parent.data.repository.issue.labels.nodes = []
  writeFileSync(file, JSON.stringify(parent))
}

function reviewRequest() {
  const { epic, env } = sandboxOf()
  const modulePath = path.join(import.meta.dirname, 'epic-driver.ts')
  const script = `import { epicFinalReviewRequest } from ${JSON.stringify(modulePath)}; try { console.log(JSON.stringify(await epicFinalReviewRequest(${JSON.stringify(epic)}, 1))) } catch (e) { console.error(String(e)); process.exit(2) }`
  return spawnSync('bun', ['-e', script], { cwd: epic, env, encoding: 'utf8' })
}

describe('epic-driver — fresh admission before final review advancement', () => {
  it.each<'blocker' | 'tier'>(['blocker', 'tier'])('refuses mark-fix after parent %s drift', (change) => {
    prepareFinalReview(true)
    changeParent(change)
    const run = drive(['mark-fix', '--ticket', '2'])
    expect(run.code, run.stderr).toBe(2)
    expect(writes()).toEqual([])
    expect(eventPayloads(2)).not.toContainEqual(expect.objectContaining({ event: 'epic-fix' }))
  })

  it('allows mark-fix with the same unchanged accepted parent', () => {
    prepareFinalReview(true)
    const run = drive(['mark-fix', '--ticket', '2'])
    expect(run.code, run.stderr).toBe(0)
    expect(eventPayloads(2)).toContainEqual(expect.objectContaining({ event: 'epic-fix', run: RUN }))
  })

  it.each<'blocker' | 'tier'>(['blocker', 'tier'])(
    'refuses a fresh final-review request after parent %s drift',
    (change) => {
      prepareFinalReview(false)
      changeParent(change)
      const run = reviewRequest()
      expect(run.status, run.stderr).toBe(2)
      expect(writes()).toEqual([])
    },
  )

  it('authorizes a fresh final-review request for the unchanged accepted parent', () => {
    const range = prepareFinalReview(false)
    const run = reviewRequest()
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ target: 'o/r#1', range })
    expect(writes()).toEqual([])
  })
})
