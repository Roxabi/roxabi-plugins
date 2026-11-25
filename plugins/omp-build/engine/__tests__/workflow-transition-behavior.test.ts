import { describe, expect, test } from 'vitest'
import { parseRecord } from '../record-construction.ts'
import type { WorkflowGraph } from '../workflow-graph.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { binding, history, must, SCOPE } from './workflow-test-support.ts'
import { featureMandate, nativeCausal, pr, rootNode } from './workflow-transition-native-fixture.ts'

describe('workflow transition behavior', () => {
  test('refuses a mandate published with the grouped-fix graph unless it was already abandoned', async () => {
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
