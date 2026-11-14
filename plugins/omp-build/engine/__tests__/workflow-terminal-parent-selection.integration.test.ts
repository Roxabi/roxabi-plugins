import { expect, it } from 'vitest'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { decisions, shippedFacts } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { actionCompletion } from '../workflow-action-completion.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

it('does not replay Parent integration after a retained invalid terminal', async () => {
  const checkout = nativeImplementationGit()
  try {
    const [first, second, third] = checkout.merges
    if (!first || !second || !third) throw new Error('missing parent merges')
    await threeDeliveredChildren(
      {
        ...checkout,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, first, second].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(third, checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const fixtures = roxabiWorkflowFixtures()
        const base = fixtures.implementStart(world.parent)
        if (base.payload.action !== 'implement' || base.payload.phase !== 'start')
          throw new Error('missing integration base')
        const manifest = {
          ...base.payload.inputs.manifest,
          purpose: 'integrate' as const,
          operands: { action: 'integrate' as const, exactInputs: base.payload.exactInputs },
        }
        const start = buildRecord({
          ...base,
          payload: {
            ...base.payload,
            action: 'integrate',
            inputs: { ...base.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) },
          },
        })
        if (
          !start.ok ||
          start.value.kind !== 'action-receipt' ||
          start.value.payload.action !== 'integrate' ||
          start.value.payload.phase !== 'start'
        )
          throw new Error('invalid integration START')
        const result = buildRecord({
          ...world.parentScope,
          version: 1,
          recordId: 'integration-negative',
          runId: world.parent.runId,
          operationId: 'integration-negative-op',
          kind: 'action-receipt',
          payload: {
            ...start.value.payload,
            phase: 'result',
            start: { scope: world.parentScope, recordId: start.value.recordId, kind: 'action-receipt' },
            native: { completion: 'completed', strict: 'invalid', raw: null },
            structured: null,
            admission: null,
            diagnostics: [{ code: 'integration-output-invalid', message: 'integration-output-invalid' }],
          },
        })
        if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
        const previous = world.observation.histories.find((h) => h.source.scope.target === world.parentScope.target)
        if (!previous) throw new Error('missing Parent history')
        const existing = previous.operations.flatMap((op) => (op.record ? [op.record] : []))
        const issue = fixtures.historyFrom([...existing, start.value, result.value])
        const histories = world.observation.histories.map((h) => (h === previous ? issue : h))
        const observation = { ...world.observation, histories }
        const causal = { histories, observation, catalogues: observation.catalogues }
        const evidence = { issue, pullRequest: null, parents: [], causal }
        const completion = actionCompletion('implement', evidence, decisions(), world.parent)
        expect(['blocked', 'uncertain']).toContain(completion.status)
        const next = reconstructWorkflow({ evidence, facts: shippedFacts(world.parent), decisions: decisions() })
        expect(next.status).toBe('blocked')
      },
    )
  } finally {
    checkout.cleanup()
  }
})
