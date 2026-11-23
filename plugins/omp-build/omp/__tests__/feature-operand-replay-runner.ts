import { buildRecord } from '../../engine/record-construction.ts'
import type { Scope } from '../../engine/record-values.ts'
import { mechanicalSpecDelta } from '../../engine/workflow-spec-assessment.ts'
import { executeDurableUwCommand } from '../../roxabi/uw-command-read.ts'
import { readAssessmentSpecFacts } from '../../roxabi/uw-current-facts.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'

const [cwd = '', raw = '', mode = ''] = process.argv.slice(2)
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('unexpected-uw-write')
    },
  },
})

async function prepareAssessment({ uw, head }: { uw: Scope; head: string }) {
  const read = await operations.readUw(uw)
  if (read.accepted.status !== 'accepted') throw new Error('accepted assessment operands missing')
  const { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage } = read.accepted.value
  if (ref.sourceAccepted.kind !== 'mandate') throw new Error('assessment fixture mandate missing')
  const accepted = { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage }
  const current = await readAssessmentSpecFacts({ uw, read, coverage: null })
  if (!current.ok) throw new Error(`proposed assessment operands missing: ${JSON.stringify(current)}`)
  const proposed = current.value.currentSpec
  const exactInputs = {
    format: 'omp-build-spec-assessment/3' as const,
    accepted,
    proposed,
    attachedChildren: [],
    attachedWayfinders: [],
    childOwnSources: [],
    identityAllocations: current.value.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
  const actionId = 'initial-assessment-action'
  const prepared = await operations.prepareAction({
    actionId,
    purpose: 'assess-spec',
    subject: { kind: 'uw', uw, pullRequest: null, binding: null },
    code: { repository: uw.repository, base: head, head, referenceCommit: head },
    operands: { action: 'assess-spec', origin: { kind: 'native-current' }, exactInputs },
    stageSources: [],
    expandedContext: [],
  })
  if (!prepared.ok) throw new Error(`assessment preparation refused: ${JSON.stringify(prepared.diagnostics)}`)
  const { inputs, snapshot: actionSnapshot } = prepared.value
  const operands = inputs.manifest.operands
  if (operands?.action !== 'assess-spec') throw new Error('assessment operands missing')
  // Seed a historical receipt without an originating native producer.
  const start = buildRecord({
    ...uw,
    version: 1,
    recordId: 'initial-assessment-start',
    runId: actionId,
    operationId: actionId,
    kind: 'action-receipt',
    payload: {
      format: 'omp-build-action-receipt/2',
      phase: 'start',
      action: 'assess-spec',
      actionId,
      mandate: { ...ref.sourceAccepted, kind: 'mandate' },
      inputs,
      exactInputs: operands.exactInputs,
    },
  })
  if (!start.ok) throw new Error(`assessment start fixture invalid: ${JSON.stringify(start.diagnostics)}`)
  return { start: start.value, inputs, snapshot: actionSnapshot }
}

if (mode === 'prepare') {
  process.stdout.write(`${JSON.stringify(await prepareAssessment(JSON.parse(raw)))}\n`)
} else {
  const result = await executeDurableUwCommand({ kind: 'action', requestFile: raw }, operations)
  if (result.kind !== 'result') throw new Error(result.reason)
  process.stdout.write(`${JSON.stringify(result.value)}\n`)
}
