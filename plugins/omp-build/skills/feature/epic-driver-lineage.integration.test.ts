import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  effectiveMandateRole,
  parseIssueSpecBody,
  parseRecord,
  rawSource,
  resolveAcceptedSpec,
  selectApplicableMandate,
  selectWorkflowBinding,
} from '../../contracts.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  childNode,
  ME,
  prNode,
  RUN,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git, sandbox, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

const scope = (number: number) => ({ repository: 'o/r', target: `o/r#${number}` })
function snapshot(number: number, body: string) {
  const uw = scope(number)
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`invalid fixture spec ${number}`)
  return parsed.snapshot
}

function prepareAncestorIssues(state: string, depth: 0 | 1 | 2) {
  const file = path.join(state, 'uw-1.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const issue = data.data.repository.issue
  issue.parent = { number: 3, repository: { nameWithOwner: 'o/r' } }
  writeFileSync(file, JSON.stringify(data))
  const ancestor = (number: number, parent: number | null, childNumber: number) => {
    const copy = JSON.parse(JSON.stringify(data))
    const item = copy.data.repository.issue
    item.number = number
    item.parent = parent === null ? null : { number: parent, repository: { nameWithOwner: 'o/r' } }
    item.subIssues.nodes = [{ number: childNumber, repository: { nameWithOwner: 'o/r' } }]
    writeFileSync(path.join(state, `uw-${number}.json`), JSON.stringify(copy))
  }
  ancestor(3, depth === 2 ? 4 : null, 1)
  if (depth === 2) ancestor(4, null, 3)
}

function publishFixtureBranches(epic: string) {
  for (const branch of ['feat/1-own-work', 'feat/2-first-child']) {
    git(epic, 'switch', '-q', '-c', branch, 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', branch)
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
  }
}

function prepare(depth: 0 | 1 | 2, armed: boolean) {
  const { epic, state } = sandbox()
  const f = roxabiWorkflowFixtures()
  const body = strictSpecBody('works')
  const child = childNode(2, 'feat(x): first child')
  const own = (n: number, text = body) => f.ownSpecFromSnapshot(scope(n), snapshot(n, text))
  const grant = (n: number, text = body): Parameters<typeof f.epicMandate>[1][number] => {
    const spec = snapshot(n, text)
    return { scope: scope(n), snapshot: spec, specVersion: spec.spec.version, tier: 'S' }
  }
  const g = f.epicMandate(scope(4), [grant(3)], { body, ownSpec: own(4), recordId: 'mandate-g' })
  const pDraft = f.epicMandate(scope(3), [grant(1)], { body, ownSpec: own(3), recordId: 'mandate-p' })
  const parsedP = parseRecord({
    ...pDraft,
    payload: { ...pDraft.payload, parent: depth === 2 ? f.mandateRef(g) : null },
  })
  if (!parsedP.ok || parsedP.value.kind !== 'mandate') throw new Error('invalid parent fixture')
  const p = parsedP.value
  const u = f.featureMandate(scope(1), {
    body,
    ownSpec: own(1),
    parent: depth ? f.mandateRef(p) : null,
    branch: 'feat/1-own-work',
    run: RUN,
    runId: RUN,
    recordId: 'mandate-u',
  })
  const initial = mandateAssessmentState(u)
  const parentShape = f.epicMandate(scope(1), [grant(2, child.body)], { body, ownSpec: own(1) })
  const proposed = {
    ...proposedAssessmentState(initial, { body, children: parentShape.payload.children }),
    snapshot: initial.snapshot,
  }
  const assessment = assessFixture(u, 'u-becomes-parent', initial, proposed, 'material')
  const uRecords = [u, assessment.start, assessment.result, acceptMaterialFixture(u, 'u-accept-child', assessment)]
  const gh = f.historyFrom([g])
  const ph = f.historyFrom([p], ME, ME, depth === 2 ? [gh] : [])
  const ancestors = [ph, gh].slice(0, depth)
  const uh = f.historyFrom(uRecords, ME, ME, ancestors)
  expect(selectApplicableMandate(uh, ancestors)).toMatchObject({
    status: 'applicable',
    mandate: { recordId: u.recordId },
  })
  const accepted = resolveAcceptedSpec(u, [uh, ...ancestors])
  if (!accepted.ok) throw new Error(`accepted U refused: ${accepted.reason}`)
  expect(effectiveMandateRole(u.payload.role, accepted.spec)).toBe('epic')
  expect(u.payload.permissions).toEqual({ landing: true, correct: true })
  const c = f.featureMandate(scope(2), {
    body: child.body,
    ownSpec: own(2, child.body),
    parent: f.mandateRef(u),
    branch: 'feat/2-first-child',
    run: 'run00002',
    runId: 'run00002',
    recordId: 'mandate-c',
  })
  const ch = f.historyFrom([c], ME, ME, [uh, ...ancestors])
  expect(selectApplicableMandate(ch, [uh, ...ancestors])).toMatchObject({
    status: 'applicable',
    mandate: { recordId: c.recordId },
  })
  const comments = (
    records: Parameters<typeof f.framedBodies>[0],
    histories: Parameters<typeof f.framedBodies>[2] = [],
  ) => f.framedBodies(records, ME, histories).map((entry) => ({ body: entry, author: ME }))
  const tip = git(epic, 'rev-parse', 'HEAD')
  const ownPr = prNode(11, 'feat/1-own-work', tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: { enabledAt: 'x' },
  })
  const childPr = prNode(12, 'feat/2-first-child', tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: { enabledAt: 'x' },
  })
  function prepareArmedPullRequests() {
    publishFixtureBranches(epic)
    const bindings: [number, typeof u, typeof uh, string, typeof ancestors][] = [
      [11, u, uh, 'feat/1-own-work', ancestors],
      [12, c, ch, 'feat/2-first-child', [uh, ...ancestors]],
    ]
    for (const [number, mandate, history, branch, histories] of bindings) {
      const binding = f.workflowBinding(scope(number), mandate, branch, 'main')
      const bindingHistory = f.historyFrom([binding], ME, ME, [history, ...histories])
      expect(
        selectWorkflowBinding({
          pullRequest: scope(number),
          histories: [bindingHistory, history, ...histories],
          native: { branch, base: 'main' },
        }),
      ).toMatchObject({ status: 'bound', mandate: f.mandateRef(mandate) })
      serveComments(number, comments([binding], [history, ...histories]))
      servePr(number, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
      const file = path.join(state, 'pr', `${number}.json`)
      const view = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...view, headRefName: branch, baseRefName: 'main' }))
    }
  }
  if (armed) prepareArmedPullRequests()
  const node = armed ? childNode(2, 'feat(x): first child', { prs: [childPr] }) : child
  serveEpic([{ ...node, fixtureComments: comments([c], [uh, ...ancestors]) }], comments(uRecords, ancestors), {
    mandate: false,
  })
  if (depth) serveComments(3, comments([p], depth === 2 ? [gh] : []))
  if (depth === 2) serveComments(4, comments([g]))
  if (armed) {
    const file = path.join(state, 'containment-1.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.data.repository.issue.closedByPullRequestsReferences.nodes = [ownPr]
    writeFileSync(file, JSON.stringify(data))
    writeFileSync(path.join(state, 'branch-prs-1.json'), JSON.stringify([ownPr]))
  }
  if (depth) prepareAncestorIssues(state, depth)
  return { epic, state }
}

describe('epic-driver explicit mandate lineage', () => {
  it.each<0 | 1 | 2>([0, 1, 2])('advances a current parent at ancestor depth %i', (depth) => {
    const { epic } = prepare(depth, false)
    const result = drive(['next'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })
  it.each<0 | 1 | 2>([0, 1, 2])('contains both own and child PRs at ancestor depth %i', (depth) => {
    const { state } = prepare(depth, true)
    const result = drive(['control-disarm'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.json()).toMatchObject({ failed: [] })
    for (const number of [11, 12]) {
      const pr = JSON.parse(readFileSync(path.join(state, 'pr', `${number}.json`), 'utf8'))
      expect(pr.autoMergeRequest).toBeNull()
      expect(pr.labels).toEqual([])
    }
  })
  it.each(['missing', 'edited'])('refuses %s grandparent without mutations', (damage) => {
    const { epic, state } = prepare(2, true)
    const file = path.join(state, 'comments-4.json')
    if (damage === 'missing') writeFileSync(file, '[]')
    else {
      const comments = JSON.parse(readFileSync(file, 'utf8'))
      comments[comments.length - 1].updated_at = '2026-10-22T12:00:00Z'
      writeFileSync(file, JSON.stringify(comments))
    }
    const before = [11, 12].map((n) => readFileSync(path.join(state, 'pr', `${n}.json`), 'utf8'))
    for (const command of [['next'], ['control-disarm']]) {
      const result = drive(command)
      expect(result.code).not.toBe(0)
      expect(writes()).toEqual([])
      expect(git(epic, 'branch', '--show-current')).toBe('')
      expect([11, 12].map((n) => readFileSync(path.join(state, 'pr', `${n}.json`), 'utf8'))).toEqual(before)
    }
  })
})
