import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, selectWorkflowBinding } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  childNode,
  epicEvent,
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
const PREFIX = Array.from({ length: 30 }, (_, index) => `ordinary-${index + 1}`)

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function prepare(stopped: boolean, labels: 'hidden' | 'complete' | 'unreadable' | 'missing') {
  const { epic, state, root } = sandbox()
  git(epic, 'switch', '-q', '-c', BRANCH, 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', BRANCH)
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  // The GraphQL connection is the first page, not the complete gate view.
  const connection = {
    nodes: labels === 'unreadable' ? null : PREFIX.map((name) => ({ name })),
    ...(labels === 'missing'
      ? {}
      : { pageInfo: { hasNextPage: labels === 'hidden', endCursor: labels === 'hidden' ? 'cursor-30' : null } }),
  }
  const candidate = prNode(11, BRANCH, tip, { labels: connection, autoMergeRequest: null })
  const node = childNode(2, 'feat(x): first child', { prs: [candidate] })
  const other = childNode(3, 'feat(x): second child')
  const fixtures = roxabiWorkflowFixtures()
  const parentScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: 'o/r#2' }
  const prScope = { repository: 'o/r', target: 'o/r#11' }
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, node.body)
  const otherScope = { repository: 'o/r', target: 'o/r#3' }
  const otherSnapshot = snapshot(otherScope, other.body)
  const parent = fixtures.epicMandate(
    parentScope,
    [
      { scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' },
      { scope: otherScope, snapshot: otherSnapshot, specVersion: otherSnapshot.spec.version, tier: 'S' },
    ],
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
  serveEpic([{ ...node, fixtureComments: comments }, other], framedRecords(1, [parent]), { mandate: false })
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
  servePr(11, { state: 'OPEN', labels: labels === 'hidden' ? [...PREFIX, 'reviewed'] : PREFIX, autoMerge: false })
  const prFile = path.join(state, 'pr', '11.json')
  const view = JSON.parse(readFileSync(prFile, 'utf8'))
  writeFileSync(prFile, JSON.stringify({ ...view, headRefName: BRANCH, baseRefName: 'main' }))

  // Preserve other labels when the native simulator removes reviewed.
  const gh = path.join(root, 'bin', 'gh')
  const stub = readFileSync(gh, 'utf8')
  const oldEdit = "jq -c '.labels = []'"
  if (!stub.includes(oldEdit)) throw new Error('simulator edit seam changed')
  writeFileSync(gh, stub.replace(oldEdit, 'jq -c \'.labels |= map(select(.name != "reviewed"))\''))

  // Branch discovery supplies the candidate; issue references remain empty.
  const epicFile = path.join(state, 'epic.json')
  const epicData = JSON.parse(readFileSync(epicFile, 'utf8'))
  epicData.data.repository.issue.subIssues.nodes[0].closedByPullRequestsReferences.nodes = []
  epicData.data.repository.issue.subIssues.nodes[0].timelineItems.nodes = []
  writeFileSync(epicFile, JSON.stringify(epicData))
  const containmentFile = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentFile, 'utf8'))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = []
  containment.data.repository.issue.timelineItems.nodes = []
  writeFileSync(containmentFile, JSON.stringify(containment))
}

function gate() {
  return JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
}

describe('epic-driver — hidden reviewed label in native PR inventory', () => {
  for (const stopped of [true, false]) {
    it(`refuses incomplete labels before ${stopped ? 'reconciling a stopped' : 'resuming an'} owned PR`, () => {
      prepare(stopped, 'hidden')
      expect(gate()).toMatchObject({ state: 'OPEN', autoMergeRequest: null })
      expect(gate().labels.map((label: { name: string }) => label.name)).toEqual([...PREFIX, 'reviewed'])
      const run = drive(['next'])
      expect(run.code).toBe(2)
      expect(run.stderr).toMatch(/label.*(incomplete|unreadable)|(incomplete|unreadable).*label/i)
      expect(writes()).toEqual([])
      expect(gate().labels.map((label: { name: string }) => label.name)).toEqual([...PREFIX, 'reviewed'])
      expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
    })
  }

  it('resumes a complete unarmed PR without disarming it', () => {
    prepare(false, 'complete')
    const run = drive(['next'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ step: { action: 'resume', ticket: 2, branch: BRANCH }, disarmed: null })
    expect(gate().labels.map((label: { name: string }) => label.name)).toEqual(PREFIX)
    expect(writes()).toEqual([])
  })

  it('refuses an unreadable label prefix without claiming a clean gate', () => {
    prepare(false, 'unreadable')
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toMatch(/incomplete|unreadable/i)
    expect(writes()).toEqual([])
  })

  it('refuses missing label completeness without writes or a switch', () => {
    prepare(false, 'missing')
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toMatch(/label.*(incomplete|unreadable)|(incomplete|unreadable).*label/i)
    expect(writes()).toEqual([])
    expect(git(sandboxOf().epic, 'branch', '--show-current')).toBe('')
  })
})
