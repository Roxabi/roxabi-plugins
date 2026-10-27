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

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

type Ownership = 'owned' | 'unbound' | 'foreign'

function armedChild(ownership: Ownership, stopped = false, second?: 'unbound' | 'foreign'): void {
  const { epic } = sandbox()
  git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  const armed = prNode(11, 'feat/2-first-child', tip, {
    labels: { nodes: [{ name: 'reviewed' }] },
    autoMergeRequest: { enabledAt: 'x' },
  })
  const other = prNode(12, 'feat/2-first-child', tip, {
    labels: { nodes: [{ name: 'reviewed' }] },
    autoMergeRequest: { enabledAt: 'x' },
  })
  const node = childNode(2, 'feat(x): first child', { prs: second ? [armed, other] : [armed] })
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
    branch: 'feat/2-first-child',
    runId: 'run00002',
    run: 'run00002',
  })
  const parentHistory = fixtures.historyFrom([parent])
  const childHistory = fixtures.historyFrom([child], ME, ME, [parentHistory])
  const comments = fixtures.framedBodies([child], ME, [parentHistory]).map((body) => ({ body, author: ME }))
  if (stopped) {
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
  }
  serveEpic([{ ...node, fixtureComments: comments }], framedRecords(1, [parent]), { mandate: false })
  for (const number of second ? [11, 12] : [11]) {
    servePr(number, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    const file = path.join(sandboxOf().state, 'pr', `${number}.json`)
    const view = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...view, headRefName: 'feat/2-first-child', baseRefName: 'main' }))
  }

  function bindCandidate(number: number, candidateOwnership: Ownership): void {
    if (candidateOwnership === 'unbound') return
    const foreignScope = { repository: 'o/r', target: 'o/r#3' }
    const foreignBody = strictSpecBody('independent work')
    const foreign = fixtures.featureMandate(foreignScope, {
      body: foreignBody,
      ownSpec: fixtures.ownSpecFromSnapshot(foreignScope, snapshot(foreignScope, foreignBody)),
      branch: 'feat/2-first-child',
      runId: RUN,
      run: RUN,
    })
    const owner = candidateOwnership === 'owned' ? child : foreign
    const ownerHistory = candidateOwnership === 'owned' ? childHistory : fixtures.historyFrom([foreign])
    const external = candidateOwnership === 'owned' ? [childHistory, parentHistory] : [ownerHistory]
    if (candidateOwnership === 'foreign') serveComments(3, framedRecords(3, [foreign]))
    const candidateScope = number === 11 ? prScope : { repository: 'o/r', target: `o/r#${number}` }
    const binding = fixtures.workflowBinding(candidateScope, owner, 'feat/2-first-child', 'main')
    const prHistory = fixtures.historyFrom([binding], ME, ME, external)
    expect(
      selectWorkflowBinding({
        pullRequest: candidateScope,
        histories: [prHistory, ...external],
        native: { branch: 'feat/2-first-child', base: 'main' },
      }),
    ).toMatchObject({ status: 'bound', mandate: fixtures.mandateRef(owner) })
    serveComments(
      number,
      fixtures.framedBodies([binding], ME, external).map((body) => ({ body, author: ME })),
    )
  }
  for (const [number, candidateOwnership] of [[11, ownership], ...(second ? [[12, second] as const] : [])] as const) {
    bindCandidate(number, candidateOwnership)
  }
}

function expectArmedAndUnchanged(): void {
  expect(writes()).toEqual([])
  const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
  expect(pr).toMatchObject({ state: 'OPEN', labels: [{ name: 'reviewed' }], autoMergeRequest: { enabledAt: 'x' } })
}

function expectOwnershipRefusal(run: ReturnType<typeof drive>): void {
  expect(run.code).toBe(2)
  expect(run.stderr).toContain('driver=refused')
}

describe('epic-driver — child stop PR ownership', () => {
  it.each<Ownership>(['unbound', 'foreign'])('refuses to stop against an %s hinted PR', (ownership) => {
    armedChild(ownership)
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expectArmedAndUnchanged()
    expect(eventPayloads(2).filter((event) => event.event === 'goal-stop')).toEqual([])
    expectOwnershipRefusal(run)
  })

  it.each(['unbound', 'foreign'] as const)(
    'preflights an owned PR before refusing a mixed batch with a %s PR',
    (ownership) => {
      armedChild('owned', false, ownership)
      const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
      expectOwnershipRefusal(run)
      expect(run.stderr).toContain('containment PR #12 binding is')
      expectArmedAndUnchanged()
      const other = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '12.json'), 'utf8'))
      expect(other).toMatchObject({
        state: 'OPEN',
        labels: [{ name: 'reviewed' }],
        autoMergeRequest: { enabledAt: 'x' },
      })
      expect(eventPayloads(2).filter((event) => event.event === 'goal-stop')).toEqual([])
    },
  )

  it('disarms the exact child-owned PR and records the stop', () => {
    armedChild('owned')
    const run = drive(['stop', '--ticket', '2', '--reason', 'timeout'])
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ ticket: 2, stop: 'timeout', disarmed: { 11: 'disarmed' } })
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr).toMatchObject({ state: 'OPEN', labels: [], autoMergeRequest: null })
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'timeout' }),
    )
  })

  it('does not reconcile an unbound hinted PR for an already stopped child', () => {
    armedChild('unbound', true)
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'timeout' }),
    )
    const run = drive(['next'])
    expectArmedAndUnchanged()
    expectOwnershipRefusal(run)
  })

  it('does not disarm an unbound hinted PR while resuming a child', () => {
    armedChild('unbound')
    const run = drive(['next'])
    expectArmedAndUnchanged()
    expectOwnershipRefusal(run)
  })
})
