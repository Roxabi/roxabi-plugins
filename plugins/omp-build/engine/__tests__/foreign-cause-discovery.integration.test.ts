import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { observedComment } from '../../testing/record-history.ts'
import { readCauseDispositionHeads } from '../cause-heads.ts'
import { specDigest } from '../record-digests.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey, validateUwGraph } from '../uw-graph.ts'
import { projectUwWaits } from '../uw-waits.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { deliveredLeaf } from './uw-delivery-proof-fixture.ts'

test('a foreign cause claim cannot attribute unrelated history damage to a trusted UW wait projection', async () => {
  const fixture = await deliveredLeaf('Approve (clean)', 64, true)
  expect(assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))).toMatchObject({
    state: 'complete',
    role: 'leaf',
    spec: fixture.accepted.ref,
    code: fixture.inputs.manifest.code,
  })
  const z = { repository: 'acme/app', target: 'acme/app#2064' }
  const date = '2026-10-27T12:00:00.000Z'
  const damaged = decodeHistory({
    scope: z,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: [
      observedComment({
        locator: 'z-legacy',
        nativeId: 'z-legacy',
        author: 'operator',
        body: '<!-- omp-build:mandate -->',
      }),
    ],
  })
  const graph = {
    ...fixture.observation.graph,
    nodes: [
      ...fixture.observation.graph.nodes.map((node) =>
        scopeKey(node.uw) === scopeKey(fixture.parentScope) ? { ...node, blockers: [z] } : node,
      ),
      {
        uw: z,
        title: 'Unrelated blocker',
        raw: { reference: z.target, body: '', bodySha256: specDigest(''), lastEditedAt: date },
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN' as const, stateReason: null },
      },
    ],
  }
  expect(validateUwGraph(graph)).toMatchObject({ ok: true })
  const baseline = { ...fixture.observation, graph, histories: [...fixture.observation.histories, damaged] }
  const headInput = { uw: fixture.uw, catalogues: baseline.catalogues }
  expect(readCauseDispositionHeads({ ...headInput, histories: fixture.observation.histories })).toEqual({
    ok: true,
    value: [],
  })
  const damagedHeads = readCauseDispositionHeads({ ...headInput, histories: baseline.histories })
  expect(damagedHeads.ok).toBe(false)
  if (damagedHeads.ok) throw new Error('Expected unrelated damaged history to fail cause validation')
  expect(damagedHeads.diagnostics.map((entry) => entry.code)).toContain('cause-history-unconfirmed')
  expect(resolveAcceptedSpec(fixture.mandate, baseline.histories).ok).toBe(true)
  const waits = projectUwWaits(baseline)
  expect(waits.diagnostics).toEqual([])
  const assessment = assessUwCompletion(baseline)
  expect(assessment.completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
  expect(assessment.dependencies.get(scopeKey(z))).toMatchObject({ state: 'held' })
  const home = fixture.review.issueHistory
  expect(
    home.operations.some(
      (entry) => entry.kind === 'cause-disposition' || entry.claimedKinds.includes('cause-disposition'),
    ),
  ).toBe(false)
  const foreign = observedComment({
    locator: 'foreign-cause',
    nativeId: 'foreign-cause',
    author: 'intruder',
    body: '<!-- omp-build:cause-disposition -->',
  })
  const withComment = (author: string) =>
    decodeHistory({
      ...home.source,
      comments: [...home.source.comments, { ...foreign, author }],
    })
  const trustedDamage = withComment(home.source.expectedAuthor)
  const trustedWaits = projectUwWaits({
    ...baseline,
    histories: baseline.histories.map((history) => (history === home ? trustedDamage : history)),
  })
  expect(
    trustedWaits.diagnostics.some(
      (entry) =>
        entry.code === 'cause-history-unconfirmed' &&
        entry.location.kind === 'native' &&
        scopeKey(entry.location.uw) === scopeKey(fixture.uw),
    ),
  ).toBe(true)
  const noisy = withComment('intruder')
  expect(noisy.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'cause-disposition', status: 'legacy', authority: 'foreign', record: null }),
      expect.objectContaining({ kind: 'mandate', recordId: fixture.mandate.recordId, authority: 'accounted' }),
    ]),
  )
  const result = projectUwWaits({
    ...baseline,
    histories: baseline.histories.map((history) => (history === home ? noisy : history)),
  })
  expect(result).toEqual(waits)
  const noisyCompletion = assessUwCompletion({
    ...baseline,
    histories: baseline.histories.map((history) => (history === home ? noisy : history)),
  })
  expect(noisyCompletion.completions.get(scopeKey(fixture.uw))?.state).toBe(
    assessment.completions.get(scopeKey(fixture.uw))?.state,
  )
})
