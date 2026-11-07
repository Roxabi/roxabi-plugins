import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { runNestedDeliveryScenario } from '../../testing/nested-delivery-world.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey } from '../uw-graph.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { mandatesOf, workflowOperationProblem } from '../workflow-control.ts'
import { resolveCurrentInheritedOwnSpecRefs } from '../workflow-current-inheritance.ts'
import { selectedMandate } from '../workflow-mandate-admission.ts'

test('ambiguous active outer authority holds current descendants without erasing historical effective Specs', async () => {
  const { root, middleScope: middle, leaf, rootMandate, final } = await runNestedDeliveryScenario('complete')
  if (!final) throw new Error('Root delivery result unavailable')
  const scopes = [root, middle, leaf]
  const captured = scopes.map((scope) => {
    const completion = final.completion.completions.get(scopeKey(scope))
    if (completion?.state !== 'complete') throw new Error(`Expected completed ${scope.target}`)
    expect(final.completion.dependencies.get(scopeKey(scope))).toMatchObject({ state: 'satisfied' })
    const historical = resolveSpecEffective({
      mode: 'historical',
      own: completion.spec,
      versionVector: completion.versionVector,
      histories: final.observation.histories,
    })
    expect(historical.ok).toBe(true)
    expect(
      resolveSpecEffective({
        mode: 'current',
        own: completion.spec,
        graph: final.observation.graph,
        histories: final.observation.histories,
      }).ok,
    ).toBe(true)
    return { scope, completion, historical }
  })
  const rootHistory = final.observation.histories.find((history) => scopeKey(history.source.scope) === scopeKey(root))
  if (!rootHistory) throw new Error('Expected root history')
  expect(selectedMandate(rootHistory)).toMatchObject({ kind: 'mandate', recordId: rootMandate.recordId })
  expect(resolveCurrentInheritedOwnSpecRefs(leaf, final.observation.graph, final.observation.histories).ok).toBe(true)

  const duplicate = buildRecord({
    ...rootMandate,
    recordId: 'nested-root-second-active-mandate',
    operationId: 'nested-root-second-active-operation',
  })
  if (!duplicate.ok || duplicate.value.kind !== 'mandate') throw new Error('Invalid second root mandate')
  expect(duplicate.value.payload).toEqual(rootMandate.payload)
  expect(duplicate.value.recordId).not.toBe(rootMandate.recordId)
  expect(duplicate.value.operationId).not.toBe(rootMandate.operationId)
  const encoded = encodeParts(duplicate.value, '# Second active root mandate', 65_536)
  if (!encoded.ok) throw new Error('Cannot encode second root mandate')
  const comments = encoded.value.map((body, index) => {
    const nativeId = `906000000${index}`
    expect(rootHistory.source.comments.some((comment) => comment.nativeId === nativeId)).toBe(false)
    return {
      locator: `comment-${nativeId}`,
      nativeId,
      body,
      author: rootHistory.source.expectedAuthor,
      createdAt: '2026-10-27T12:00:00Z',
      updatedAt: '2026-10-27T12:00:00Z',
    }
  })
  const changedRootHistory = decodeHistory({
    ...rootHistory.source,
    comments: [...rootHistory.source.comments, ...comments],
  })
  const histories = final.observation.histories.map((history) =>
    scopeKey(history.source.scope) === scopeKey(root) ? changedRootHistory : history,
  )
  const claims = mandatesOf(changedRootHistory)
  expect(claims).toHaveLength(2)
  expect(new Set(claims.map((claim) => claim.recordId)).size).toBe(2)
  expect(new Set(claims.map((claim) => claim.operationId)).size).toBe(2)
  expect(changedRootHistory.operations.filter((operation) => operation.kind === 'mandate')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        recordId: rootMandate.recordId,
        status: 'complete',
        authority: expect.not.stringMatching('foreign'),
      }),
      expect.objectContaining({
        recordId: duplicate.value.recordId,
        status: 'complete',
        authority: expect.not.stringMatching('foreign'),
      }),
    ]),
  )
  expect(workflowOperationProblem(changedRootHistory)).toBeNull()
  expect(resolveAcceptedSpec(rootMandate, histories).ok).toBe(true)
  expect(resolveAcceptedSpec(duplicate.value, histories).ok).toBe(true)
  expect(selectedMandate(changedRootHistory)).toMatchObject({ status: 'refused', reason: 'ambiguous' })
  expect(resolveCurrentInheritedOwnSpecRefs(leaf, final.observation.graph, histories).ok).toBe(false)

  const assessment = assessUwCompletion({ ...final.observation, histories })
  for (const { scope, completion, historical } of captured) {
    expect(
      resolveSpecEffective({
        mode: 'historical',
        own: completion.spec,
        versionVector: completion.versionVector,
        histories,
      }),
    ).toEqual(historical)
    expect
      .soft(
        resolveSpecEffective({
          mode: 'current',
          own: completion.spec,
          graph: final.observation.graph,
          histories,
        }).ok,
      )
      .toBe(false)
    expect.soft(assessment.completions.get(scopeKey(scope))?.state).not.toBe('complete')
    expect.soft(assessment.dependencies.get(scopeKey(scope))).toMatchObject({ state: 'held' })
  }
}, 60_000)
