import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../contracts.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  type Comment,
  childNode,
  epicEvent,
  eventPayloads,
  framedRecords,
  prNode,
  RUN,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records'
import {
  cleanupSandbox,
  detail,
  drive,
  git,
  sandbox,
  sandboxOf,
  writes,
} from './testing/epic-driver/epic-driver-sandbox'

afterEach(cleanupSandbox)

function record(draft: Parameters<typeof buildRecord>[0]): CanonicalRecord {
  const built = buildRecord(draft)
  if (!built.ok) throw new Error(built.diagnostics.map((entry) => entry.message).join(', '))
  return built.value
}

function strictSnapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function setNativeStateReason(issue: number, stateReason: string): void {
  const fixture = path.join(sandboxOf().state, `uw-${issue}.json`)
  const graph = JSON.parse(readFileSync(fixture, 'utf8')) as {
    data: { repository: { issue: { stateReason: string | null } } }
  }
  graph.data.repository.issue.stateReason = stateReason
  writeFileSync(fixture, JSON.stringify(graph))
}

function successorRecords(): Comment[] {
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const children = [childNode(2, 'feat(x): first child')]
  const fixtures = roxabiWorkflowFixtures()
  const childScope = { repository: 'o/r', target: `o/r#${children[0].number}` }
  const childSnapshot = strictSnapshot(childScope, children[0].body)
  const approvedChildren = [
    { scope: childScope, specVersion: childSnapshot.spec.version, snapshot: childSnapshot, tier: 'S' as const },
  ]
  const epicBody = strictSpecBody('works')
  const epicSnapshot = strictSnapshot(scope, epicBody)
  const first = fixtures.epicMandate(scope, approvedChildren, {
    recordId: 'epic-m1',
    body: epicBody,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, epicSnapshot),
  })
  const second = fixtures.epicMandate(scope, approvedChildren, {
    recordId: 'epic-m2',
    runId: 'run00002',
    operationId: 'op-epic-m2',
    antecedent: fixtures.mandateRef(first),
    body: epicBody,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, epicSnapshot),
  })
  const firstRef = fixtures.mandateRef(first)
  const secondRef = fixtures.mandateRef(second)
  return framedRecords(1, [
    first,
    record({
      version: 1,
      recordId: 'abandon-m1',
      runId: RUN,
      operationId: 'op-abandon-m1',
      repository: scope.repository,
      target: scope.target,
      kind: 'operator-control',
      payload: { control: 'abandon', controlId: 'abandon-m1', mandate: firstRef, predecessor: null },
    }),
    second,
    record({
      version: 1,
      recordId: 'select-m2',
      runId: RUN,
      operationId: 'op-select-m2',
      repository: scope.repository,
      target: scope.target,
      kind: 'operator-control',
      payload: {
        control: 'select-successor',
        controlId: 'select-m2',
        mandate: secondRef,
        predecessor: firstRef,
        successor: secondRef,
      },
    }),
  ])
}

describe('epic-driver — the gate', () => {
  it('does not report an accepted child as changed for its never-accepted wayfinder', () => {
    sandbox()
    const fixtures = roxabiWorkflowFixtures()
    const parentScope = { repository: 'o/r', target: 'o/r#1' }
    const childScope = { repository: 'o/r', target: 'o/r#2' }
    const child = childNode(2, 'feat(x): first child')
    const parentBody = strictSpecBody('works')
    const childSnapshot = strictSnapshot(childScope, child.body)
    const parent = fixtures.epicMandate(
      parentScope,
      [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
      {
        body: parentBody,
        ownSpec: fixtures.ownSpecFromSnapshot(parentScope, strictSnapshot(parentScope, parentBody)),
      },
    )
    const childMandate = fixtures.featureMandate(childScope, {
      body: child.body,
      ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
      parent: fixtures.mandateRef(parent),
    })
    serveEpic(
      [
        {
          ...child,
          fixtureComments: fixtures
            .framedBodies([childMandate], 'operator', [fixtures.historyFrom([parent])])
            .map((body) => ({ body, author: 'operator' })),
        },
      ],
      framedRecords(1, [parent]),
      { mandate: false },
    )
    const childPath = path.join(sandboxOf().state, 'uw-2.json')
    const childGraph = JSON.parse(readFileSync(childPath, 'utf8'))
    childGraph.data.repository.issue.subIssues.nodes = [{ number: 3, repository: { nameWithOwner: 'o/r' } }]
    writeFileSync(childPath, JSON.stringify(childGraph))
    const wayfinderGraph = structuredClone(childGraph)
    const wayfinder = wayfinderGraph.data.repository.issue
    wayfinder.number = 3
    wayfinder.title = 'wayfinder map'
    wayfinder.labels.nodes = [{ name: 'wayfinder:map' }]
    wayfinder.parent = { number: 2, repository: { nameWithOwner: 'o/r' } }
    wayfinder.subIssues.nodes = []
    writeFileSync(path.join(sandboxOf().state, 'uw-3.json'), JSON.stringify(wayfinderGraph))

    const run = drive(['next'])
    expect(run.code, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2 })
  })

  it('acts on nothing without a confirmed mandate', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')], [], { mandate: false })
    const run = drive(['next'])
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('driver=assisted no confirmed mandate authorizes epic #1')
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })

  it('refuses to run on the Principal', () => {
    const { principal } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(['next'], { cwd: principal })
    expect(run.code).toBe(2)
    expect(git(principal, 'branch', '--show-current')).toBe('main')
  })

  it('continues under a selected successor after its antecedent was abandoned', () => {
    const { epic } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')], successorRecords(), { mandate: false })

    const run = drive(['next'])

    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })

  it('still refuses an abandoned mandate without a selected successor', () => {
    sandbox()
    const scope = { repository: 'o/r', target: 'o/r#1' }
    const children = [childNode(2, 'feat(x): first child')]
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.epicMandate(
      scope,
      children.map((child) => fixtures.childSnapshot({ repository: 'o/r', target: `o/r#${child.number}` }, child.body)),
      { recordId: 'epic-m1' },
    )
    const abandoned = record({
      version: 1,
      recordId: 'abandon-m1',
      runId: RUN,
      operationId: 'op-abandon-m1',
      repository: scope.repository,
      target: scope.target,
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-m1',
        mandate: fixtures.mandateRef(mandate),
        predecessor: null,
      },
    })
    serveEpic(children, framedRecords(1, [mandate, abandoned]), { mandate: false })

    const run = drive(['next'])

    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — next', () => {
  it('starts the first child from origin/<base>, ignoring a foreign canonical stop event', () => {
    const { epic } = sandbox()
    const forged = framedRecords(2, [
      epicEvent(2, 'foreign-stop', { event: 'goal-stop', run: RUN, reason: 'base-blocked', detail: '' }),
    ]).map((comment) => ({ ...comment, author: 'mallory' }))
    serveEpic([
      childNode(2, 'feat(x): first child', { comments: forged }),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'OPEN']] }),
    ])
    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(run.json().step.report.skipped).toEqual([{ ticket: 3, blockers: [2] }])
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(git(epic, 'rev-parse', 'refs/remotes/origin/main'))
  })

  it('does not schedule a child behind a native NOT_PLANNED sibling, but starts behind COMPLETED', () => {
    const { epic: notPlannedEpic } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): prerequisite', { state: 'CLOSED' }),
      childNode(3, 'fix(y): dependent child', { blockedBy: [[2, 'CLOSED']] }),
    ])
    setNativeStateReason(2, 'NOT_PLANNED')
    const notPlanned = drive(['next'])
    const notPlannedBranch = git(notPlannedEpic, 'branch', '--show-current')
    const notPlannedWrites = writes()

    cleanupSandbox()

    const { epic: completedEpic } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): prerequisite', { state: 'CLOSED' }),
      childNode(3, 'fix(y): dependent child', { blockedBy: [[2, 'CLOSED']] }),
    ])
    setNativeStateReason(2, 'COMPLETED')
    const completed = drive(['next'])

    expect(notPlanned.code).toBe(0)
    expect(notPlanned.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(notPlanned.json().step.report.skipped).toEqual([{ ticket: 3, blockers: [2] }])
    expect(notPlannedBranch).toBe('')
    expect(notPlannedWrites).toEqual([])
    expect(completed.code).toBe(0)
    expect(completed.json().step).toMatchObject({ action: 'start', ticket: 3, branch: 'fix/3-dependent-child' })
    expect(git(completedEpic, 'branch', '--show-current')).toBe('fix/3-dependent-child')
    expect(writes()).toEqual([])
  })

  it('confirms a merged child, deletes its local branch and starts the next one', () => {
    const { epic, root } = sandbox()
    serveEpic([
      childNode(2, 'feat(x): first child'),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'OPEN']] }),
    ])
    drive(['next'])
    writeFileSync(path.join(epic, 'one.txt'), 'one\n')
    git(epic, 'add', 'one.txt')
    git(epic, 'commit', '-qm', 'feat(x): first child (#2)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    const base = git(epic, 'rev-parse', 'refs/remotes/origin/main')
    git(root, 'clone', '-q', sandboxOf().origin, 'merger')
    const merger = path.join(root, 'merger')
    git(merger, 'merge', '-q', '--no-ff', 'origin/feat/2-first-child', '-m', 'Merge pull request #10')
    git(merger, 'push', '-q', 'origin', 'main')
    const mergeSha = git(merger, 'rev-parse', 'HEAD')
    const merged = prNode(10, 'feat/2-first-child', tip, {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: mergeSha, parents: { nodes: [{ oid: base }] } },
    })
    serveEpic([
      childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] }),
      childNode(3, 'fix(y): second child', { blockedBy: [[2, 'CLOSED']] }),
    ])
    setNativeStateReason(2, 'COMPLETED')

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().cleaned).toEqual(['feat/2-first-child'])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 3, branch: 'fix/3-second-child' })
    expect(git(epic, 'branch', '--list', 'feat/2-first-child')).toBe('')
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(mergeSha)
  })

  it('disarms an armed PR before recording a stop it proved itself', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    writeFileSync(path.join(epic, 'x.txt'), 'x\n')
    git(epic, 'add', 'x.txt')
    git(epic, 'commit', '-qm', 'feat(z): sneaked in (#99)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'foreign-commit', disarmed: { 11: 'disarmed' } }])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'foreign-commit' }),
    )
  })

  it('stops on an open PR whose head is not the pushed branch', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'f'.repeat(40))] })])
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const run = drive(['next'])
    expect(run.json().recorded).toMatchObject([{ ticket: 2, stop: 'branch-mismatch' }])
    expect(git(epic, 'branch', '--show-current')).toBe('')
  })
})

describe('epic-driver — stop', () => {
  function armedChild(): string {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveEpic([childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] })])
    return epic
  }

  it('refuses a reason that is not a ticket stop', () => {
    armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    expect(drive(['stop', '--ticket', '2', '--reason', 'base-ci-red']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a dirty tree', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    writeFileSync(path.join(epic, 'wip.txt'), 'wip\n')
    expect(drive(['stop', '--ticket', '2', '--reason', 'timeout']).code).toBe(1)
    expect(writes()).toEqual([])
  })

  it('disarms, detaches and keeps the branch before recording a canonical stop event', () => {
    const epic = armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout', ...detail("watch timed out; it's re-run later")])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({
        event: 'goal-stop',
        run: RUN,
        reason: 'timeout',
        detail: "watch timed out; it's re-run later",
      }),
    )
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(git(epic, 'branch', '--list', 'feat/2-first-child')).not.toBe('')
  })

  it('writes no event when the PR is still armed after the disarm', () => {
    armedChild()
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true }, true)
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(1)
    expect(writes().filter((line) => line.startsWith('comment'))).toEqual([])
  })

  it('writes no event when the PR merged before the disarm', () => {
    armedChild()
    servePr(11, { state: 'MERGED', labels: ['reviewed'], autoMerge: false })
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ ticket: 2, merged: 11 })
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — review and report', () => {
  it('refuses a final review the driver does not expect', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const range = `${'a'.repeat(40)}..${'b'.repeat(40)}`
    expect(drive(['review', '--range', range]).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('refuses a complete report before the goal is complete', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['report', '--outcome', 'complete']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it('disarms every armed child PR on drop and posts one canonical report event per run', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    const children = [
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
    ]
    serveEpic(children)
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const first = drive(['report', '--outcome', 'drop', '--reason', 'base-ci-red'])
    expect(first.code).toBe(0)
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 1 <!-- omp-build-record /),
    ])
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'base-ci-red' }),
    )
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    const second = drive(['report', '--outcome', 'drop', '--reason', 'base-ci-red'])
    expect(second.code).toBe(0)
    expect(writes().filter((line) => line.startsWith('comment'))).toHaveLength(1)
  })
})
