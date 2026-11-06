import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readWithAuthor } from '../../adapters/github/transport.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../../testing/uw-completion-observation.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import { buildObservedCommitIndex, deliveredChildCommit } from '../uw-delivery-lineage.ts'
import { assessUwDeliveryProof } from '../uw-delivery-proof.ts'
import { scopeKey, type UwNativeNode } from '../uw-graph.ts'
import { recordsOf } from '../workflow-control.ts'
import { deliveredLeaf, threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

const root: Scope = { repository: 'org/repo', target: 'org/repo#1' }
const blocker: Scope = { repository: 'org/repo', target: 'org/repo#2' }
const date = '2026-10-27T12:00:00.000Z'

function commitIndex(observation: UwCompletionObservation) {
  const index = buildObservedCommitIndex(observation)
  if (!index.ok) throw new Error(`Cannot index declared native commits: ${JSON.stringify(index.diagnostics)}`)
  return index.value
}

function node(uw: Scope, blockers: Scope[], closed: boolean): UwNativeNode {
  return {
    uw,
    title: uw.target,
    raw: { reference: uw.target, body: '', bodySha256: specDigest(''), lastEditedAt: date },
    updatedAt: date,
    labels: ['size:S'],
    wayfinderLabels: [],
    parent: null,
    children: [],
    blockers,
    native: { state: closed ? 'CLOSED' : 'OPEN', stateReason: closed ? 'COMPLETED' : null },
  }
}

async function blockerResolution(comments: unknown[]) {
  const source = await readWithAuthor(
    blocker,
    {
      cwd: '/simulated',
      gh: async () => JSON.stringify(comments),
    },
    'operator',
    null,
  )
  const rootHistory = decodeHistory({
    scope: root,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
  const observation = await observedUwWithoutPullRequests({
    graph: {
      status: 'complete',
      root,
      observedAt: date,
      nodes: [node(root, [blocker], false), node(blocker, [], true)],
    },
    histories: [rootHistory, decodeHistory(source)],
    catalogues: fixtureReviewClassCatalogues(),
  })
  const assessment = assessUwCompletion(observation)
  return assessment.dependencies.get(scopeKey(blocker))
}

test('cannot prove native-only absence when a legacy mandate marker has an unknown author', async () => {
  expect(await blockerResolution([])).toMatchObject({ state: 'satisfied', basis: { kind: 'native-only' } })
  const unknownAuthor = { id: 101, user: null, body: '<!-- omp-build:mandate -->', created_at: date, updated_at: date }
  expect(await blockerResolution([unknownAuthor])).toMatchObject({ state: 'held' })
})

test('completes an open leaf only after authenticated review and the actual bound merge', async () => {
  const fixture = await deliveredLeaf()
  const completion = assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))
  expect(completion).toMatchObject({
    state: 'complete',
    role: 'leaf',
    uw: fixture.uw,
    spec: fixture.accepted.ref,
    versionVector: [fixture.accepted.ref],
    code: fixture.inputs.manifest.code,
  })
  if (completion?.state !== 'complete') throw new Error('expected authenticated completion')
  expect(completion.sources).toEqual(
    expect.arrayContaining([
      { scope: fixture.pullRequest, kind: 'workflow-binding', recordId: fixture.binding.recordId },
      { scope: fixture.uw, kind: 'action-receipt', recordId: fixture.implementation.recordId },
      { scope: fixture.pullRequest, kind: 'review', recordId: fixture.review.review.recordId },
    ]),
  )
})

test('a materially changed current leaf Spec cannot complete or satisfy a managed dependency', async () => {
  const fixture = await deliveredLeaf()
  const key = scopeKey(fixture.uw)
  const baseline = assessUwCompletion(fixture.observation)
  expect(baseline.completions.get(key)).toMatchObject({ state: 'complete', role: 'leaf' })
  expect(baseline.dependencies.get(key)).toMatchObject({ state: 'satisfied', basis: { kind: 'accepted-uw' } })

  const native = fixture.observation.graph.nodes.find((item) => scopeKey(item.uw) === key)
  if (!native) throw new Error('Expected native leaf')
  const assessBody = (body: string) => {
    const raw = rawSource(native.raw.reference, body, native.raw.lastEditedAt)
    const parsed = parseIssueSpecBody({ uw: fixture.uw, raw })
    if (parsed.status !== 'conformant') throw new Error('Expected conformant current native Spec')
    const observation = {
      ...fixture.observation,
      graph: {
        ...fixture.observation.graph,
        nodes: fixture.observation.graph.nodes.map((item) => (scopeKey(item.uw) === key ? { ...item, raw } : item)),
      },
    }
    return { parsed, assessment: assessUwCompletion(observation) }
  }
  const noMaterial = assessBody(`${native.raw.body}\n`)
  expect(noMaterial.parsed.snapshot.spec.version).toBe(fixture.accepted.ref.version)
  expect(noMaterial.assessment.completions.get(key)).toMatchObject({ state: 'complete' })
  expect(noMaterial.assessment.dependencies.get(key)).toMatchObject({ state: 'satisfied' })

  const changedBody = native.raw.body.replace('Save keeps the selected region', 'Save deletes the selected region')
  expect(changedBody).not.toBe(native.raw.body)
  const changed = assessBody(changedBody)
  expect(changed.parsed.snapshot.spec.criteria[0]?.id).toBe('C1')
  expect(changed.parsed.snapshot.spec.version).not.toBe(fixture.accepted.ref.version)
  expect(changed.assessment.completions.get(key)?.state).not.toBe('complete')
  expect(changed.assessment.dependencies.get(key)).toMatchObject({ state: 'held' })
})

test('duplicate selected review histories, including conflicting native bytes, cannot prove delivery', async () => {
  const fixture = await deliveredLeaf()
  expect(assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))).toMatchObject({
    state: 'complete',
  })
  const selected = fixture.review.history
  const first = selected.source.comments[0]
  if (!first) throw new Error('Expected native review history comments')
  const conflicting = decodeHistory({
    ...selected.source,
    comments: [{ ...first, body: `${first.body}\nConflicting native content` }, ...selected.source.comments.slice(1)],
  })
  for (const duplicate of [selected, conflicting]) {
    const observation = { ...fixture.observation, histories: [...fixture.observation.histories, duplicate] }
    const proof = assessUwDeliveryProof(
      observation,
      fixture.uw,
      fixture.accepted,
      fixture.effective,
      [],
      commitIndex(observation),
    )
    expect(proof).toMatchObject({ ok: false })
    expect(assessUwCompletion(observation).completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
  }
})

test('a reviewed candidate cannot replace actual merge identity, matching head, or observed merge parents', async () => {
  const fixture = await deliveredLeaf()
  const facts = fixture.observation.delivery[0]
  if (facts === undefined) throw new Error('Expected native delivery facts')
  const pull = facts.pullRequests[0]
  if (pull === undefined) throw new Error('Expected native pull request')
  const worlds = [
    { ...facts, pullRequests: [{ ...pull, state: 'CLOSED' as const, mergeCommit: null }] },
    { ...facts, pullRequests: [{ ...pull, head: 'a'.repeat(40) }] },
    { ...facts, commits: facts.commits.filter((item) => item.code.commit !== fixture.merge) },
    {
      ...facts,
      commits: facts.commits.map((item) =>
        item.code.commit === fixture.merge ? { ...item, parents: ['b'.repeat(40), fixture.head] } : item,
      ),
    },
  ]
  expect(assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))?.state).toBe('complete')
  for (const world of worlds) {
    const result = assessUwCompletion({ ...fixture.observation, delivery: [world] })
    expect(result.completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
  }
})

test('inconsistent observed commit parents or repository cannot prove delivery', async () => {
  const fixture = await deliveredLeaf()
  expect(assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))).toMatchObject({
    state: 'complete',
  })
  const facts = fixture.observation.delivery.find((item) => item.uw.target === fixture.uw.target)
  if (!facts) throw new Error('Expected leaf delivery facts')
  const merge = facts.commits.find((item) => item.code.commit === fixture.merge)
  const head = facts.commits.find((item) => item.code.commit === fixture.head)
  if (!merge || !head || merge.parents.length !== 2)
    throw new Error('Expected actual candidate and ordered merge observations')
  const corrupted = [
    { ...facts, commits: [...facts.commits, { ...merge, parents: [...merge.parents].reverse() }] },
    { ...facts, commits: [...facts.commits, { ...head, code: { ...head.code, repository: 'other/repo' } }] },
  ]
  for (const item of corrupted) {
    const observation = { ...fixture.observation, delivery: [item] }
    expect(assessUwCompletion(observation).completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
  }
})

test('foreign branch binding and unavailable evidence authority cannot complete the leaf', async () => {
  const fixture = await deliveredLeaf()
  const facts = fixture.observation.delivery[0]
  if (facts === undefined) throw new Error('Expected native delivery facts')
  const pull = facts.pullRequests[0]
  if (pull === undefined) throw new Error('Expected native pull request')
  const wrongBinding = { ...facts, pullRequests: [{ ...pull, branch: 'feat/foreign' }] }
  expect(
    assessUwCompletion({ ...fixture.observation, delivery: [wrongBinding] }).completions.get(scopeKey(fixture.uw))
      ?.state,
  ).not.toBe('complete')
  const issue = fixture.review.issueHistory
  const operation = issue.operations.find((entry) => entry.recordId === fixture.implementation.recordId)
  if (!operation) throw new Error('expected captured implementation operation')
  const parts = new Set(operation.parts.map((part) => part.locator))
  const foreign = decodeHistory({
    ...issue.source,
    comments: issue.source.comments.map((part) => (parts.has(part.locator) ? { ...part, author: 'intruder' } : part)),
  })
  const observation = { ...fixture.observation, histories: [foreign, fixture.review.history] }
  expect(assessUwCompletion(observation).completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
})

test('delivery proof rejects a version vector that is not the accepted vector', async () => {
  const fixture = await deliveredLeaf()
  const current = assessUwDeliveryProof(
    fixture.observation,
    fixture.uw,
    fixture.accepted,
    fixture.effective,
    [],
    commitIndex(fixture.observation),
  )
  expect(current.ok).toBe(true)
  const other = { ...fixture.effective.own, version: 'e'.repeat(64) }
  const stale: SpecEffective = {
    ...fixture.effective,
    versionVector: [other, ...fixture.effective.versionVector.slice(1)],
  }
  const result = assessUwDeliveryProof(
    fixture.observation,
    fixture.uw,
    fixture.accepted,
    stale,
    [],
    commitIndex(fixture.observation),
  )
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected version mismatch')
  expect(result.diagnostics.map((item) => item.code)).toContain('delivery-spec-mismatch')
})

test('an authenticated inherited leaf binds the whole current ancestor vector', async () => {
  const fixture = await deliveredLeaf('Approve (clean)', 52, true)
  expect(fixture.effective.versionVector).toHaveLength(2)
  expect(
    assessUwDeliveryProof(
      fixture.observation,
      fixture.uw,
      fixture.accepted,
      fixture.effective,
      [],
      commitIndex(fixture.observation),
    ),
  ).toMatchObject({ ok: true })
  const ancestor = fixture.effective.versionVector[1]
  if (!ancestor) throw new Error('Expected an inherited ancestor')
  const stale: SpecEffective = {
    ...fixture.effective,
    versionVector: [fixture.effective.versionVector[0], { ...ancestor, version: 'f'.repeat(64) }],
  }
  expect(
    assessUwDeliveryProof(
      fixture.observation,
      fixture.uw,
      fixture.accepted,
      stale,
      [],
      commitIndex(fixture.observation),
    ),
  ).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'delivery-spec-mismatch' })]),
  })
})

test('a completed child alone does not prove its parent delivery', async () => {
  const fixture = await deliveredLeaf('Approve (clean)', 53, true)
  const observation = {
    ...fixture.observation,
    root: fixture.parentScope,
    graph: { ...fixture.observation.graph, root: fixture.parentScope },
    delivery: [
      ...fixture.observation.delivery,
      { uw: fixture.parentScope, pullRequests: [], integrations: [], commits: [] },
    ],
  }
  const assessment = assessUwCompletion(observation)
  expect(assessment.completions.get(scopeKey(fixture.uw))).toMatchObject({ state: 'complete', role: 'leaf' })
  expect(assessment.completions.get(scopeKey(fixture.parentScope))).toMatchObject({ state: 'not-complete' })
})

test('three independently merged children remain distinct in bottom-up completion', async () => {
  await threeDeliveredChildren(
    {
      p0: 'a'.repeat(40),
      merges: ['b', 'c', 'd'].map((value) => value.repeat(40)),
      heads: ['1', '2', '3'].map((value) => value.repeat(40)),
      parentHead: 'e'.repeat(40),
      trees: ['4', '5', '6'].map((value) => value.repeat(40)),
      baseTrees: ['7', '4', '5'].map((value) => value.repeat(40)),
      mergeTrees: ['4', '5', '6'].map((value) => value.repeat(40)),
      parentTree: 'f'.repeat(40),
      diff: new TextEncoder().encode('diff --git a/fixture.txt b/fixture.txt\n'),
    },
    [{ id: 'C1', statement: 'Save keeps the selected region' }],
    'planned',
    async (world) => {
      const result = assessUwCompletion(world.observation)
      for (const [index, child] of world.reviews.entries()) {
        const completion = result.completions.get(scopeKey(child.uw))
        expect(completion).toMatchObject({
          state: 'complete',
          role: 'leaf',
          code: { base: child.base, head: child.head },
        })
        if (completion?.state !== 'complete') throw new Error(`Child ${child.uw.target} did not complete`)
        expect(deliveredChildCommit(world.observation.delivery, completion, commitIndex(world.observation))).toBe(
          world.merges[index],
        )
      }
      expect(new Set(world.reviews.map((child) => child.merge)).size).toBe(3)
      expect(result.completions.get(scopeKey(world.parentScope))?.state).not.toBe('complete')
    },
  )
})

test('a passing declaration cannot launder a missing native test execution', async () => {
  const fixture = await deliveredLeaf()
  expect(assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))?.state).toBe('complete')
  const changed = recordsOf(fixture.review.issueHistory).map((record) => {
    if (
      record.recordId !== fixture.implementation.recordId ||
      record.kind !== 'action-receipt' ||
      record.payload.action !== 'implement' ||
      record.payload.phase !== 'result'
    )
      return record
    return { ...record, payload: { ...record.payload, native: { ...record.payload.native, bashCalls: [] } } }
  })
  const history = roxabiWorkflowFixtures().historyFrom(changed)
  const observation = { ...fixture.observation, histories: [history, fixture.review.history] }
  expect(assessUwCompletion(observation).completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
})
