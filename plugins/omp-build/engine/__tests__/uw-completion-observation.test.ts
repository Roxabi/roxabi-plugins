import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import { scopeKey, type UwNativeNode } from '../uw-graph.ts'

const root: Scope = { repository: 'org/repo', target: 'org/repo#1' }
const blocker: Scope = { repository: 'external/repo', target: 'external/repo#2' }
const date = '2026-10-27T12:00:00.000Z'
function native(uw: Scope, state: 'OPEN' | 'CLOSED', stateReason: string | null, blockers: Scope[] = []): UwNativeNode {
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
    native: { state, stateReason },
  }
}
function history(scope: Scope, complete = true) {
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: 'operator',
    complete,
    comments: [],
    diagnostics: [],
  })
}
function observation(
  stateReason: string | null,
  complete = true,
): Extract<UwCompletionObservation, { status: 'complete' }> {
  return {
    status: 'complete',
    root,
    graph: {
      status: 'complete',
      root,
      observedAt: date,
      nodes: [native(root, 'OPEN', null, [blocker]), native(blocker, 'CLOSED', stateReason)],
    },
    histories: [history(root), history(blocker, complete)],
    catalogues: fixtureReviewClassCatalogues(),
    delivery: [],
  }
}

test('requires full absence evidence as well as CLOSED/COMPLETED for a native-only blocker', () => {
  const done = assessUwCompletion(observation('COMPLETED')).dependencies.get(scopeKey(blocker))
  expect(done?.state).toBe('satisfied')
  expect(done?.basis.kind).toBe('native-only')
  expect(done?.completion).toBeNull()
  expect(assessUwCompletion(observation('NOT_PLANNED')).dependencies.get(scopeKey(blocker))?.state).toBe('held')
  expect(assessUwCompletion(observation(null)).dependencies.get(scopeKey(blocker))?.state).toBe('held')
  expect(assessUwCompletion(observation('COMPLETED', false)).dependencies.get(scopeKey(blocker))?.state).toBe('held')
})

test('a foreign mandate claim prevents native-only absence even when the issue is completed', () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(blocker)
  const foreign = fixtures.historyFrom([mandate])
  const observed = observation('COMPLETED')
  const initialHistory = observed.histories[0]
  if (initialHistory === undefined) throw new Error('Expected initial observation history')
  const historyWithForeignClaim = {
    ...foreign,
    operations: foreign.operations.map((operation) => ({ ...operation, authority: 'foreign' as const })),
  }
  const assessment = assessUwCompletion({ ...observed, histories: [initialHistory, historyWithForeignClaim] })
  expect(assessment.dependencies.get(scopeKey(blocker))).toMatchObject({ state: 'held', basis: { kind: 'unresolved' } })
})

test('distinguishes blocker identity by repository as well as target', () => {
  const first = { repository: 'org/a', target: '#9' }
  const second = { repository: 'org/b', target: '#9' }
  const observed = observation('COMPLETED')
  const assessment = assessUwCompletion({
    ...observed,
    graph: {
      ...observed.graph,
      nodes: [
        native(root, 'OPEN', null, [first, second]),
        native(first, 'CLOSED', 'COMPLETED'),
        native(second, 'CLOSED', 'NOT_PLANNED'),
      ],
    },
    histories: [history(root), history(first), history(second)],
  })
  expect(assessment.dependencies.get(scopeKey(first))?.state).toBe('satisfied')
  expect(assessment.dependencies.get(scopeKey(second))?.state).toBe('held')
})
