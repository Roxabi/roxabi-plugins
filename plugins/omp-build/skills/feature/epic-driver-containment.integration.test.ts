import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeHistory,
  effectiveMandateRole,
  parseIssueSpecBody,
  parseRecord,
  rawSource,
  resolveAcceptedSpec,
  selectWorkflowBinding,
} from '../../contracts.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { isAssessResult } from '../../engine/workflow-spec-assessment.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { expectCompleteEpicObservation } from './testing/epic-driver/epic-driver-observation.ts'
import {
  childNode,
  framedRecords,
  ME,
  prNode,
  RUN,
  recordHistory,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import {
  cleanupSandbox,
  git,
  readControlTarget,
  sandbox,
  sandboxOf,
  writes,
} from './testing/epic-driver/epic-driver-sandbox.ts'
import { addForeignMandateClaim } from './testing/epic-driver/epic-driver-serve.ts'

afterEach(cleanupSandbox)

type Change = 'wayfinder' | 'removed'
function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function assessmentAtCheckout(seed: ReturnType<typeof assessFixture>, epic: string) {
  if (seed.start.kind !== 'action-receipt') throw new Error('Expected assessment START')
  const head = git(epic, 'rev-parse', 'HEAD')
  if (git(epic, 'rev-parse', 'refs/remotes/origin/main') !== head)
    throw new Error('Assessment checkout does not match the observed base')
  const manifest = {
    ...seed.start.payload.inputs.manifest,
    code: { repository: 'o/r', base: head, head, referenceCommit: head },
  }
  const inputs = { ...seed.start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const start = buildRecord({ ...seed.start, payload: { ...seed.start.payload, inputs } })
  const result = buildRecord({ ...seed.result, payload: { ...seed.result.payload, inputs } })
  if (!start.ok || start.value.kind !== 'action-receipt' || !result.ok || !isAssessResult(result.value))
    throw new Error('Assessment with observed Git code is invalid')
  return { ...seed, start: start.value, result: result.value }
}

function prepareArmedChild(change: Change | 'none', foreignParent = false, historicalEpic = false): void {
  const { epic, state } = sandbox()
  git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
  const armed = prNode(11, 'feat/2-first-child', tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
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
  const featureMandate = fixtures.featureMandate(childScope, {
    body: node.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(owner),
    branch: 'feat/2-first-child',
    runId: 'run00002',
    run: 'run00002',
  })
  // First-mandate publication records the current branch and sets role from
  // child commitments, even when the initial role is Epic.
  const historicalParent = historicalEpic
    ? fixtures.epicMandate(
        childScope,
        [fixtures.childSnapshot({ repository: 'o/r', target: 'o/r#3' }, 'historic grandchild')],
        {
          body: node.body,
          ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
        },
      )
    : null
  const built = parseRecord(
    historicalParent !== null
      ? {
          ...featureMandate,
          payload: {
            ...featureMandate.payload,
            role: 'epic',
            children: historicalParent.payload.children,
            coverage: historicalParent.payload.coverage,
          },
        }
      : featureMandate,
  )
  if (!built.ok || built.value.kind !== 'mandate') throw new Error('historical child mandate fixture rejected')
  const childMandate = built.value
  const records: CanonicalRecord[] = [childMandate]
  if (historicalEpic) {
    const initial = mandateAssessmentState(childMandate)
    const proposed = proposedAssessmentState(initial, { body: node.body, children: [] })
    const assessment = assessmentAtCheckout(
      assessFixture(childMandate, 'child-accept-leaf', initial, proposed, 'material', [
        fixtures.historyFrom([childMandate], ME, ME, [fixtures.historyFrom([owner])]),
        fixtures.historyFrom([owner]),
        decodeHistory(recordHistory(3)),
      ]),
      epic,
    )
    records.push(
      assessment.start,
      assessment.result,
      acceptMaterialFixture(childMandate, 'accept-child-leaf', assessment),
    )
  }
  const parentHistory = fixtures.historyFrom([owner])
  const childHistory = fixtures.historyFrom(records, ME, ME, [parentHistory])
  if (historicalEpic) {
    const accepted = resolveAcceptedSpec(childMandate, [childHistory, parentHistory])
    if (!accepted.ok) throw new Error(`historical child acceptance refused: ${accepted.reason}`)
    expect(childMandate.payload.role).toBe('epic')
    expect(effectiveMandateRole(childMandate.payload.role, accepted.spec)).toBe('feature')
  }
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
        fixtureComments: fixtures.framedBodies(records, ME, [parentHistory]).map((body) => ({ body, author: ME })),
      },
    ],
    framedRecords(1, [parent]),
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

function editChildMandateComment(): void {
  const file = path.join(sandboxOf().state, 'comments-2.json')
  const comments = JSON.parse(readFileSync(file, 'utf8'))
  const mandate = comments.find((entry: { body: string }) => entry.body.includes('kind=mandate '))
  if (!mandate) throw new Error('missing child mandate fixture')
  mandate.updated_at = '2026-10-21T10:00:01Z'
  writeFileSync(file, JSON.stringify(comments))
  const source = recordHistory(
    2,
    comments.map((entry: { body: string; user: { login: string } }) => ({
      body: entry.body,
      author: entry.user.login,
    })),
  )
  source.comments = source.comments.map((comment, index) => ({
    ...comment,
    createdAt: comments[index].created_at,
    updatedAt: comments[index].updated_at,
  }))
  const decoded = decodeHistory(source)
  expect(decoded.diagnostics).toContainEqual(expect.objectContaining({ code: 'record-edited' }))
  expect(decoded.operations).toContainEqual(
    expect.objectContaining({
      kind: 'mandate',
      status: 'invalid',
      authority: 'accounted',
      record: null,
    }),
  )
}

function expectDiscovered(ticket: number): void {
  const result = readControlTarget()
  expect(result.code, result.stderr).toBe(0)
  expect(result.json().openPrs).toEqual([{ ticket, pr: 11 }])
  expect(writes()).toEqual([])
}

describe('epic-driver — accepted child containment after topology drift', () => {
  it('discovers the bound child when topology is unchanged', () => {
    prepareArmedChild('none')
    expectDiscovered(2)
  })

  it.each(([1, 2] as const).flatMap((home) => (['legacy', 'copy'] as const).map((claim) => ({ home, claim }))))(
    'discovers the accepted child despite foreign $claim on home $home',
    ({ home, claim }) => {
      prepareArmedChild('none')
      addForeignMandateClaim(home, claim)
      expectDiscovered(2)
    },
  )

  it('refuses containment after the child mandate was edited', () => {
    prepareArmedChild('removed')
    clearIssuePrLinks()
    editChildMandateComment()
    expect(readControlTarget().code).not.toBe(0)
    expect(writes()).toEqual([])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
  })

  it('permits a complete empty child history with no PR', () => {
    prepareArmedChild('removed')
    clearIssuePrLinks()
    serveComments(2, [])
    writeFileSync(path.join(sandboxOf().state, 'branch-prs-2.json'), '[]')
    unlinkSync(path.join(sandboxOf().state, 'pr', '11.json'))
    const run = readControlTarget()
    expect(run.code, run.stderr).toBe(0)
    expect(run.json().openPrs).toEqual([])
    expect(writes()).toEqual([])
  })

  it('discovers the bound child that was originally an Epic', async () => {
    prepareArmedChild('removed', false, true)
    clearIssuePrLinks()
    await expectCompleteEpicObservation()
    expectDiscovered(2)
  })

  it('refuses a candidate bound to a different parent mandate', () => {
    prepareArmedChild('none', true)
    expect(readControlTarget().code).not.toBe(0)
    expect(writes()).toEqual([])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
  })

  it('refuses containment when an accepted removed child is inaccessible', () => {
    prepareArmedChild('removed')
    unlinkSync(path.join(sandboxOf().state, 'uw-2.json'))
    expect(readControlTarget().code).not.toBe(0)
    expect(writes()).toEqual([])
  })

  it.each<Change>(['wayfinder', 'removed'])('recovers a bound %s child PR without issue links', (change) => {
    prepareArmedChild(change)
    clearIssuePrLinks()
    expectDiscovered(2)
  })

  it('remains unconfirmed when branch discovery is unavailable', () => {
    prepareArmedChild('removed')
    clearIssuePrLinks()
    writeFileSync(path.join(sandboxOf().state, 'branch-unavailable'), '')
    expect(readControlTarget().code).not.toBe(0)
    expect(writes()).toEqual([])
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
  })

  it.each<Change>(['wayfinder', 'removed'])('discovers the accepted %s child', (change) => {
    prepareArmedChild(change)
    expectDiscovered(2)
  })
})

function prepareArmedOwnPr(role: 'leaf' | 'accepted-parent'): void {
  const { epic, state } = sandbox()
  const branch = 'feat/1-own-work'
  git(epic, 'switch', '-q', '-c', branch, 'refs/remotes/origin/main')
  git(epic, 'push', '-q', 'origin', branch)
  const tip = git(epic, 'rev-parse', 'HEAD')
  git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')

  const fixtures = roxabiWorkflowFixtures()
  const rootScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: 'o/r#2' }
  const prScope = { repository: 'o/r', target: 'o/r#11' }
  const body = strictSpecBody('works')
  const child = childNode(2, 'feat(x): first child')
  const childSnapshot = snapshot(childScope, child.body)
  const children: Parameters<typeof fixtures.epicMandate>[1] = [
    { scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' },
  ]
  const options = {
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(rootScope, snapshot(rootScope, body)),
    branch,
    runId: RUN,
    run: RUN,
  }
  const epicMandate = fixtures.epicMandate(rootScope, children, options)
  const mandate = fixtures.featureMandate(rootScope, options)
  const records: CanonicalRecord[] = [mandate]
  if (role === 'accepted-parent') {
    const initial = mandateAssessmentState(mandate)
    if (epicMandate.payload.coverage === null) throw new Error('Expected declared parent coverage')
    const proposed = {
      ...proposedAssessmentState(initial, { body, children: epicMandate.payload.children }),
      snapshot: initial.snapshot,
      coverage: epicMandate.payload.coverage,
    }
    const assessment = assessmentAtCheckout(
      assessFixture(mandate, 'root-accept-parent', initial, proposed, 'material', [
        fixtures.historyFrom([mandate], ME, ME),
        decodeHistory(recordHistory(2)),
      ]),
      epic,
    )
    records.push(assessment.start, assessment.result, acceptMaterialFixture(mandate, 'accept-root-parent', assessment))
  }
  const rootHistory = fixtures.historyFrom(records, ME, ME)
  const accepted = resolveAcceptedSpec(mandate, [rootHistory])
  if (!accepted.ok) throw new Error(`root acceptance refused: ${accepted.reason}`)
  expect(mandate.payload.role).toBe('feature')
  expect(effectiveMandateRole(mandate.payload.role, accepted.spec)).toBe(role === 'leaf' ? 'feature' : 'epic')
  expect(accepted.spec.children).toHaveLength(role === 'leaf' ? 0 : 1)

  const binding = fixtures.workflowBinding(prScope, mandate, branch, 'main')
  const prHistory = fixtures.historyFrom([binding], ME, ME, [rootHistory])
  expect(
    selectWorkflowBinding({
      pullRequest: prScope,
      histories: [prHistory, rootHistory],
      native: { branch, base: 'main' },
    }),
  ).toMatchObject({ status: 'bound', mandate: fixtures.mandateRef(mandate) })
  const armed = prNode(11, branch, tip, {
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: { enabledAt: 'x' },
  })
  serveEpic(role === 'leaf' ? [] : [child], framedRecords(1, records))
  if (role !== 'leaf') serveComments(2, [])
  serveComments(
    11,
    fixtures.framedBodies([binding], ME, [rootHistory]).map((entry) => ({ body: entry, author: ME })),
  )
  servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
  const prPath = path.join(state, 'pr', '11.json')
  const prView = JSON.parse(readFileSync(prPath, 'utf8'))
  writeFileSync(prPath, JSON.stringify({ ...prView, headRefName: branch, baseRefName: 'main' }))
  writeFileSync(
    path.join(state, 'containment-1.json'),
    JSON.stringify({
      data: {
        repository: {
          issue: {
            number: 1,
            repository: { nameWithOwner: 'o/r' },
            closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [armed] },
            timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
          },
        },
      },
    }),
  )
  writeFileSync(path.join(state, 'branch-prs-1.json'), JSON.stringify([armed]))
}

describe('epic-driver — own bound PR containment', () => {
  it('discovers an authenticated normal leaf own PR', () => {
    prepareArmedOwnPr('leaf')
    expectDiscovered(1)
  })

  it('discovers the retained own PR after a leaf accepts a child', async () => {
    prepareArmedOwnPr('accepted-parent')
    await expectCompleteEpicObservation()
    expectDiscovered(1)
  })

  it.each(['legacy', 'copy'] as const)('discovers the own PR despite a foreign %s claim', (claim) => {
    prepareArmedOwnPr('accepted-parent')
    addForeignMandateClaim(1, claim)
    expectDiscovered(1)
  })

  it.each(['leaf', 'accepted-parent'] as const)('refuses containment for an edited %s home', (role) => {
    prepareArmedOwnPr(role)
    const file = path.join(sandboxOf().state, 'comments-1.json')
    const comments = JSON.parse(readFileSync(file, 'utf8'))
    const mandate = comments.find((entry: { body: string }) => entry.body.includes('kind=mandate '))
    if (!mandate) throw new Error('missing root mandate fixture')
    mandate.updated_at = '2026-10-21T10:00:01Z'
    writeFileSync(file, JSON.stringify(comments))

    expect(readControlTarget().code).not.toBe(0)
    const pr = JSON.parse(readFileSync(path.join(sandboxOf().state, 'pr', '11.json'), 'utf8'))
    expect(pr.autoMergeRequest).not.toBeNull()
    expect(pr.labels).toContainEqual({ name: 'reviewed' })
    expect(writes().filter((entry) => entry.startsWith('merge 11 ') || entry.startsWith('edit 11 '))).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(comments)
  })
})
