import { expect, test } from 'vitest'
import { observe, planWorld } from '../../testing/workflow-interruption-world.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { inventoryCapturedWork } from '../workflow-captured-inventory.ts'
import { withPayload } from './workflow-interruption-support.ts'

test('captured context negative holds its own mandate but not a new mandate', async () => {
  const world = planWorld()
  const config = world.mandate.payload.config
  const configuration = {
    version: config.version,
    digest: config.digest,
    serialized: JSON.stringify(config.effective),
  }
  const manifest = { ...world.start.payload.inputs.manifest, configuration }
  const inputs = { ...world.start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const start = withPayload(world.start, { inputs })
  const negative = withPayload(world.result, {
    inputs,
    structured: {
      outcome: 'missing-context',
      missing: [
        { locator: { kind: 'information-request', description: 'Deployment region' }, reason: 'Required', targets: [] },
      ],
    },
    admission: null,
    diagnostics: [],
  })
  const scope = { repository: world.mandate.repository, target: world.mandate.target }
  const predecessor = { scope, recordId: world.mandate.recordId, kind: 'mandate' as const }
  const abandoned = buildRecord({
    ...scope,
    version: 1,
    recordId: 'abandon-mandate',
    runId: 'run-1',
    operationId: 'op-abandon-mandate',
    kind: 'operator-control',
    payload: { control: 'abandon', controlId: 'abandon-mandate', mandate: predecessor, predecessor: null },
  })
  const successor = buildRecord({
    ...world.mandate,
    recordId: 'new-mandate',
    runId: 'run-2',
    operationId: 'op-new-mandate',
    payload: { ...world.mandate.payload, antecedent: predecessor },
  })
  if (!abandoned.ok || !successor.ok || successor.value.kind !== 'mandate') throw new Error('Invalid successor')
  const current = successor.value
  const currentRef = { scope, recordId: current.recordId, kind: 'mandate' as const }
  const selected = buildRecord({
    ...scope,
    version: 1,
    recordId: 'select-mandate',
    runId: 'run-2',
    operationId: 'op-select-mandate',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-mandate',
      mandate: currentRef,
      predecessor,
      successor: currentRef,
    },
  })
  if (!selected.ok) throw new Error('Invalid successor selection')
  const issue = world.issue([start, negative, abandoned.value, current, selected.value])
  const observation = await observe(issue)
  if (observation.status !== 'complete') throw new Error('Expected a complete native observation')
  const causal = { histories: observation.histories, catalogues: observation.catalogues, observation }
  const evidence = { issue, pullRequest: null, parents: [], causal }

  expect(inventoryCapturedWork(evidence, world.mandate)).toMatchObject({
    ok: false,
    diagnostics: [{ code: 'unconfirmed', message: 'Captured invocation has unresolved negative context' }],
  })
  expect(inventoryCapturedWork(evidence, current)).toMatchObject({ ok: true })
})
