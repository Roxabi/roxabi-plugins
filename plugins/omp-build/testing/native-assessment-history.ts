import { randomUUID } from 'node:crypto'
import type { Scope } from '../engine/record-values.ts'
import { capturedChildOwnSources } from '../engine/workflow-assessment-child-sources.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import { type SpecAssessment, specAssessmentSchema } from '../engine/workflow-output-schema.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import { mechanicalSpecDelta } from '../engine/workflow-spec-assessment.ts'
import type { ParentCoverageRequest } from '../roxabi/feature-contract.ts'
import { readAssessmentSpecFacts } from '../roxabi/uw-current-facts.ts'
import { historicalSubmission } from './native-action-capture.ts'
import { appendNativeReceipt, type HistoryWorld, prepareHistoricalAction } from './native-history-records.ts'

type AssessmentStart = Extract<ActionReceiptPayload, { action: 'assess-spec'; phase: 'start' }>
type AssessmentAuthority = Pick<AssessmentStart, 'actionId' | 'action' | 'inputs' | 'exactInputs' | 'mandate'>

/** Seal a historical native-current assessment without going through /feature action selection. */
export async function openHistoricalAssessment(input: {
  world: HistoryWorld
  scope: Scope
  mandate: MandateRecord
  commit: string
  coverage?: ParentCoverage
  basis?: ParentCoverageRequest
}) {
  const { scope, world, mandate, commit } = input
  const read = await world.operations.readUw(scope)
  if (read.accepted.status !== 'accepted') throw new Error('Assessment fixture has no accepted Spec')
  const facts = await readAssessmentSpecFacts({
    uw: scope,
    read,
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
    ...(input.basis === undefined ? {} : { basis: input.basis }),
  })
  if (!facts.ok) throw new Error(`Assessment fixture proposal unavailable: ${JSON.stringify(facts)}`)
  const { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage } = read.accepted.value
  const accepted = { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage }
  const { currentSpec: proposed, identityAllocations } = facts.value
  const captured = capturedChildOwnSources(accepted, proposed, read.histories, [])
  if (!captured) throw new Error('Assessment fixture has unbound child authority')
  const actionId = randomUUID()
  const prepared = await prepareHistoricalAction(world, scope, {
    actionId,
    purpose: 'assess-spec',
    code: { repository: scope.repository, base: commit, head: commit, referenceCommit: commit },
    operands: {
      action: 'assess-spec',
      origin: { kind: 'native-current' },
      exactInputs: {
        format: 'omp-build-spec-assessment/3',
        accepted,
        proposed,
        identityAllocations,
        attachedChildren: [],
        attachedWayfinders: [],
        childOwnSources: captured.childOwnSources,
        mechanical: mechanicalSpecDelta(accepted, proposed),
      },
    },
  })
  const operands = prepared.inputs.manifest.operands
  if (operands?.action !== 'assess-spec') throw new Error('Assessment fixture preparation did not retain operands')
  const authority: AssessmentAuthority = {
    actionId,
    action: 'assess-spec',
    inputs: prepared.inputs,
    exactInputs: operands.exactInputs,
    mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
  }
  const start = await appendNativeReceipt(world, scope, { ...authority, phase: 'start' })
  return { start: start.ref, authority, prepared, exact: operands.exactInputs }
}

export async function appendHistoricalAssessment(
  world: HistoryWorld,
  scope: Scope,
  started: { authority: AssessmentAuthority; start: { scope: Scope; recordId: string; kind: 'action-receipt' } },
  childId: string,
  judgment: SpecAssessment,
) {
  const { native } = historicalSubmission(childId, judgment)
  return appendNativeReceipt(world, scope, {
    ...started.authority,
    phase: 'result',
    start: started.start,
    native,
    structured: specAssessmentSchema.parse(judgment),
    admission: null,
    diagnostics: [],
  })
}
