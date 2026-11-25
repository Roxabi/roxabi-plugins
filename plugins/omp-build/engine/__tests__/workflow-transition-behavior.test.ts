import { describe, expect, test } from 'vitest'
import { parseRecord } from '../record-construction.ts'
import type { WorkflowGraph } from '../workflow-graph.ts'
import { selectApplicableMandate, selectRevocableMandate } from '../workflow-mandate-admission.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { binding, history, must, SCOPE } from './workflow-test-support.ts'
import { featureMandate, nativeCausal, pr, rootNode } from './workflow-transition-native-fixture.ts'

describe('workflow transition behavior', () => {
  test('permits revocation but not execution on an unsupported grouped-fix graph', async () => {
    const current = featureMandate()
    const effective = current.payload.config.effective as { graph: WorkflowGraph }
    const graph = {
      ...effective.graph,
      nodes: [...effective.graph.nodes, { id: 'mark-fix', action: 'mark-fix' }],
      edges: [...effective.graph.edges, { from: 'ready', to: 'mark-fix', when: 'epic-fix-ticket' }],
    }
    const config = { ...current.payload.config, effective: { ...effective, graph } }
    const published = must(parseRecord({ ...current, payload: { ...current.payload, config } }))
    const active = history([published])
    expect(selectApplicableMandate(active, [], await nativeCausal([active], [rootNode]))).toMatchObject({
      status: 'refused',
      reason: 'unsupported',
      evidence: [expect.objectContaining({ code: 'unsupported-graph' })],
    })
    expect(selectRevocableMandate(active)).toMatchObject({ status: 'applicable', mandate: published })
    const abandon = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-pre-cutover',
        runId: published.runId,
        operationId: 'op-abandon-pre-cutover',
        kind: 'operator-control',
        inputs: [published.recordId],
        payload: {
          control: 'abandon',
          controlId: 'control-abandon-pre-cutover',
          predecessor: null,
          mandate: { scope: SCOPE, recordId: published.recordId, kind: 'mandate' },
        },
      }),
    )
    const abandoned = history([published, abandon])
    expect(selectApplicableMandate(abandoned, [], await nativeCausal([abandoned], [rootNode]))).toMatchObject({
      status: 'refused',
      reason: 'abandoned',
    })
    expect(selectRevocableMandate(abandoned)).toMatchObject({ status: 'refused', reason: 'abandoned' })
  })

  test('revocation needs complete unique mandate authority, not complete Accepted Spec history', () => {
    const feature = featureMandate()
    const own = history([feature])
    const operation = own.operations.find((candidate) => candidate.recordId === feature.recordId)
    if (operation === undefined) throw new Error('missing fixture mandate operation')
    const missingSpec = { ...own, operations: [operation] }
    expect(selectRevocableMandate(missingSpec)).toMatchObject({ status: 'applicable', mandate: feature })
    const identity = own.operations.find((candidate) => candidate.kind === 'spec-identity')
    if (identity === undefined) throw new Error('missing fixture identity operation')
    expect(
      selectRevocableMandate({ ...own, operations: [operation, { ...identity, status: 'invalid', record: null }] }),
    ).toMatchObject({ status: 'applicable', mandate: feature })
    expect(selectRevocableMandate({ ...own, source: { ...own.source, complete: false } })).toMatchObject({
      status: 'refused',
      reason: 'incomplete',
    })
    expect(
      selectRevocableMandate({ ...own, operations: [{ ...operation, status: 'incomplete', record: null }] }),
    ).toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    const other = must(parseRecord({ ...feature, recordId: 'mandate-2', operationId: 'op-mandate-2' }))
    expect(selectRevocableMandate(history([feature, other]))).toMatchObject({ status: 'refused', reason: 'ambiguous' })
  })

  test('refuses conflicting workflow bindings on the same pull request', () => {
    const feature = featureMandate()
    const other = must(parseRecord({ ...feature, recordId: 'mandate-2', operationId: 'op-mandate-2' }))
    expect(
      selectWorkflowBinding({
        pullRequest: pr,
        histories: [history([feature, other]), history([binding(feature, pr), binding(other, pr)], pr)],
        native: { branch: 'feature/bounded', base: 'main' },
      }).status,
    ).toBe('conflicting')
  })
})
