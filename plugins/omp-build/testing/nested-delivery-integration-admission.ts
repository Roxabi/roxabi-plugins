import type { Scope } from '../engine/record-values.ts'
import type { IntegrationOutput } from '../engine/uw-integration-schema.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import type { produceParentIntegration } from './parent-integration-producer.ts'

type Produced = Awaited<ReturnType<typeof produceParentIntegration>>
type Histories = Produced['beforeReview']['histories']

function integrationStart(histories: Histories, scope: Scope, recordId: string) {
  const history = histories.find(
    (item) => item.source.scope.target === scope.target && item.source.scope.repository === scope.repository,
  )
  const start = history ? recordsOf(history).find((item) => item.recordId === recordId) : undefined
  if (start?.kind !== 'action-receipt' || start.payload.action !== 'integrate' || start.payload.phase !== 'start')
    throw new Error('Integration START unavailable')
  return start
}

function integrationResult(histories: Histories, scope: Scope, recordId: string) {
  const parentHistory = histories.find((item) => item.source.scope.target === scope.target)
  const integrated = parentHistory ? recordsOf(parentHistory).find((item) => item.recordId === recordId) : undefined
  if (!parentHistory || integrated?.kind !== 'action-receipt' || integrated.payload.action !== 'integrate')
    throw new Error('Integration not admitted')
  if (
    integrated.payload.phase !== 'result' ||
    !integrated.payload.structured ||
    integrated.payload.structured.outcome !== 'integrated' ||
    !integrated.payload.admission?.admitted
  )
    throw new Error('Integration not admitted')
  const output = integrated.payload.structured
  const evidence = integrationEvidence(output)
  return { parentHistory, integrated, output, evidence }
}

function integrationEvidence(output: IntegrationOutput) {
  const declaration = output.criteria[0]
  if (declaration?.verification !== 'evidence' || !declaration.evidence[0])
    throw new Error('Integration evidence missing')
  return declaration.evidence[0]
}

function admittedObservation(produced: Produced) {
  const { initial: read, beforeReview: after } = produced
  if (!read.identity.ok)
    throw new Error(`Parent identity ledger unavailable: ${JSON.stringify(read.identity.diagnostics)}`)
  if (
    read.accepted.status !== 'accepted' ||
    after.accepted.status !== 'accepted' ||
    after.observation.status !== 'complete'
  )
    throw new Error('Parent accepted observation unavailable')
  const acceptedValue = after.accepted.value
  return { read, identityValue: read.identity.value, after, observation: after.observation, acceptedValue }
}

function admittedTargets(produced: Produced) {
  const childCompletion = produced.completions[0]
  if (!childCompletion) throw new Error('Integration child completion unavailable')
  const target = produced.targets[0]
  if (!target) throw new Error('Parent criterion unavailable')
  return { childCompletion, target }
}

function admittedAssignment(base: ReturnType<typeof admittedObservation>) {
  const assignment = base.acceptedValue.coverage?.assignments[0]
  if (!assignment) throw new Error('Accepted parent coverage assignment unavailable')
  return assignment
}
export function admittedIntegration(produced: Produced, scope: Scope) {
  const base = admittedObservation(produced)
  const targets = admittedTargets(produced)
  const startRecord = integrationStart(base.after.histories, scope, produced.opened.start.recordId)
  const result = integrationResult(base.after.histories, scope, produced.integrationRecordId)
  const ref = { scope, kind: 'action-receipt' as const, recordId: result.integrated.recordId }
  const assignment = admittedAssignment(base)
  return { ...base, ...targets, code: produced.code, startRecord, ...result, ref, assignment }
}

export type AdmittedIntegration = ReturnType<typeof admittedIntegration>
