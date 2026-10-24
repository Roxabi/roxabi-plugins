// Source: plugins/omp-build/roxabi/workflow.ts:316-503
import { createHash } from 'node:crypto'
import type { AssessSpecResultPayload } from '../engine/workflow-receipt-schema.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import {
  type Contracts,
  type History,
  type HistoryRecord,
  isRecord,
  payload,
  publishRecord,
  type Scope,
} from './feature-engine.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

type RecordByKind<K extends HistoryRecord['kind']> = Extract<HistoryRecord, { kind: K }>
type MaterialAssessment = AssessSpecResultPayload['exactInputs']

function matchesRecordRef(value: unknown, scope: Scope, recordId: string, kind: string): boolean {
  if (!isRecord(value) || !isRecord(value.scope)) return false
  return (
    value.scope.repository === scope.repository &&
    value.scope.target === scope.target &&
    value.recordId === recordId &&
    value.kind === kind
  )
}

function exactSpecPair(value: unknown, digest: (body: string) => string): MaterialAssessment | null {
  if (!isRecord(value)) return null
  const acceptedDigest = value.acceptedDigest
  const currentDigest = value.currentDigest
  const acceptedBody = value.acceptedBody
  const currentBody = value.currentBody
  if (
    typeof acceptedDigest !== 'string' ||
    typeof currentDigest !== 'string' ||
    typeof acceptedBody !== 'string' ||
    typeof currentBody !== 'string' ||
    digest(acceptedBody) !== acceptedDigest ||
    digest(currentBody) !== currentDigest
  )
    return null
  return { acceptedDigest, currentDigest, acceptedBody, currentBody }
}

type MaterialPredecessor = { scope: Scope; recordId: string; kind: 'mandate' | 'action-receipt' | 'operator-control' }
type AssessmentReceipt = RecordByKind<'action-receipt'>
type AssessmentResult = AssessSpecResultPayload
type MaterialControl = RecordByKind<'operator-control'>

export async function handleMaterialDecision(input: {
  decision: 'accept' | 'reject' | undefined
  loaded: Contracts
  history: History
  parents: readonly History[]
  mandate: RecordByKind<'mandate'>
  issue: { body: string }
  gh: Gh
  cwd: string
}): Promise<ContinueFeatureResult | { kind: 'accepted' }> {
  if (input.decision !== 'accept' && input.decision !== 'reject')
    return { kind: 'blocked', reason: 'material-decision-invalid' }
  const mandateScope = { repository: input.mandate.repository, target: input.mandate.target }
  const mandateRef = { scope: mandateScope, recordId: input.mandate.recordId, kind: 'mandate' as const }
  const accepted = input.loaded.resolveAcceptedSpec(input.mandate, [input.history, ...input.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: `material-decision-${accepted.reason}` }
  const currentDigest = input.loaded.specDigest(input.issue.body)
  const candidates = materialAssessmentCandidates(
    input.history,
    mandateScope,
    input.mandate.recordId,
    accepted.spec.body,
    accepted.spec.digest,
    input.issue.body,
    currentDigest,
    input.loaded.specDigest,
  )
  if (candidates.length === 0) return { kind: 'blocked', reason: 'material-decision-assessment-missing' }
  if (candidates.length > 1) return { kind: 'blocked', reason: 'material-decision-assessment-ambiguous' }
  const record = candidates[0]
  if (record === undefined) return { kind: 'blocked', reason: 'material-decision-assessment-missing' }
  const result = payload(record)
  if (!isMaterialAssessment(result)) return { kind: 'blocked', reason: 'material-decision-not-pending' }
  if (
    !matchesExactMaterialAssessment(
      result.exactInputs,
      accepted.spec.body,
      accepted.spec.digest,
      input.issue.body,
      currentDigest,
      input.loaded.specDigest,
    )
  )
    return { kind: 'blocked', reason: 'material-decision-assessment-stale' }
  if (hasAcceptedMaterialControl(input.history, mandateScope, record.recordId))
    return { kind: 'blocked', reason: 'material-decision-already-accepted' }
  if (input.decision === 'reject') return { kind: 'terminal', reason: 'material-spec-rejected' }
  const predecessor = materialPredecessor(accepted.spec.chain, mandateScope, input.mandate.recordId)
  if (predecessor === null) return { kind: 'blocked', reason: 'material-decision-chain-invalid' }
  const assessmentRef = { scope: mandateScope, recordId: record.recordId, kind: 'action-receipt' as const }
  const acceptanceId = `accept-material-${createHash('sha256')
    .update(
      JSON.stringify({
        scope: mandateScope,
        mandate: input.mandate.recordId,
        predecessor: { recordId: predecessor.recordId, kind: predecessor.kind },
        assessment: record.recordId,
        specDigest: currentDigest,
      }),
    )
    .digest('hex')}`
  const acceptance = {
    repository: mandateScope.repository,
    target: mandateScope.target,
    version: 1 as const,
    recordId: acceptanceId,
    runId: acceptanceId,
    operationId: acceptanceId,
    kind: 'operator-control' as const,
    payload: {
      control: 'accept-material' as const,
      controlId: acceptanceId,
      mandate: mandateRef,
      predecessor,
      assessment: assessmentRef,
      specDigest: currentDigest,
    },
  } satisfies Omit<RecordByKind<'operator-control'>, 'inputs'>
  const published = await publishRecord(input.loaded, input.history, acceptance, input.gh, input.cwd, input.parents)
  if (!published.ok)
    return { kind: 'blocked', reason: 'material-decision-unconfirmed', diagnostics: published.diagnostics }
  return (await materialAcceptanceConfirmed(input, mandateScope, predecessor, record.recordId, currentDigest))
    ? { kind: 'accepted' }
    : { kind: 'blocked', reason: 'material-decision-unconfirmed' }
}

function materialAssessmentCandidates(
  history: History,
  scope: Scope,
  mandateId: string,
  acceptedBody: string,
  acceptedDigest: string,
  currentBody: string,
  currentDigest: string,
  digest: (body: string) => string,
): AssessmentReceipt[] {
  const receipts = completedActionReceipts(history)
  return receipts.filter((record) =>
    isMaterialAssessmentResult(
      record,
      receipts,
      scope,
      mandateId,
      acceptedBody,
      acceptedDigest,
      currentBody,
      currentDigest,
      digest,
    ),
  )
}

function completedActionReceipts(history: History): AssessmentReceipt[] {
  return history.operations.flatMap((operation) => {
    if (operation.status === 'complete' && operation.record?.kind === 'action-receipt') return [operation.record]
    return []
  })
}

function completedMaterialControls(history: History): MaterialControl[] {
  return history.operations.flatMap((operation) => {
    if (operation.status === 'complete' && operation.record?.kind === 'operator-control') return [operation.record]
    return []
  })
}

function isMaterialAssessmentResult(
  record: AssessmentReceipt,
  receipts: readonly AssessmentReceipt[],
  scope: Scope,
  mandateId: string,
  acceptedBody: string,
  acceptedDigest: string,
  currentBody: string,
  currentDigest: string,
  digest: (body: string) => string,
): boolean {
  const body = payload(record)
  if (body.action !== 'assess-spec' || body.phase !== 'result') return false
  if (!matchesRecordRef(body.mandate, scope, mandateId, 'mandate')) return false
  if (
    !matchesExactMaterialAssessment(body.exactInputs, acceptedBody, acceptedDigest, currentBody, currentDigest, digest)
  ) {
    return false
  }
  return receipts.some((start) =>
    isAssessmentStart(start, body, scope, mandateId, acceptedBody, acceptedDigest, currentBody, currentDigest, digest),
  )
}

function isAssessmentStart(
  record: AssessmentReceipt,
  result: AssessmentResult,
  scope: Scope,
  mandateId: string,
  acceptedBody: string,
  acceptedDigest: string,
  currentBody: string,
  currentDigest: string,
  digest: (body: string) => string,
): boolean {
  const body = payload(record)
  return (
    body.action === 'assess-spec' &&
    body.phase === 'start' &&
    body.actionId === result.actionId &&
    matchesRecordRef(body.mandate, scope, mandateId, 'mandate') &&
    matchesRecordRef(result.start, scope, record.recordId, 'action-receipt') &&
    matchesExactMaterialAssessment(body.exactInputs, acceptedBody, acceptedDigest, currentBody, currentDigest, digest)
  )
}

function matchesExactMaterialAssessment(
  value: unknown,
  acceptedBody: string,
  acceptedDigest: string,
  currentBody: string,
  currentDigest: string,
  digest: (body: string) => string,
): boolean {
  const exact = exactSpecPair(value, digest)
  return (
    exact !== null &&
    exact.acceptedBody === acceptedBody &&
    exact.acceptedDigest === acceptedDigest &&
    exact.currentBody === currentBody &&
    exact.currentDigest === currentDigest
  )
}

function isMaterialAssessment(result: AssessmentReceipt['payload']): result is AssessmentResult {
  return (
    result.action === 'assess-spec' &&
    result.phase === 'result' &&
    isRecord(result.structured) &&
    result.structured.classification === 'material'
  )
}

function materialPredecessor(
  chain: readonly unknown[],
  mandateScope: Scope,
  mandateId: string,
): MaterialPredecessor | null {
  const tail = chain.at(-1)
  if (!isRecord(tail) || typeof tail.recordId !== 'string' || typeof tail.kind !== 'string') {
    return { scope: mandateScope, recordId: mandateId, kind: 'mandate' }
  }
  if (tail.kind === 'mandate') return { scope: mandateScope, recordId: tail.recordId, kind: 'mandate' }
  if (tail.kind === 'editorial') return { scope: mandateScope, recordId: tail.recordId, kind: 'action-receipt' }
  if (tail.kind === 'accept-material') return { scope: mandateScope, recordId: tail.recordId, kind: 'operator-control' }
  return null
}

function hasAcceptedMaterialControl(history: History, scope: Scope, assessmentId: string): boolean {
  return completedMaterialControls(history).some((control) => {
    const body = payload(control)
    return (
      body.control === 'accept-material' && matchesRecordRef(body.assessment, scope, assessmentId, 'action-receipt')
    )
  })
}

async function materialAcceptanceConfirmed(
  input: Parameters<typeof handleMaterialDecision>[0],
  scope: Scope,
  predecessor: MaterialPredecessor,
  assessmentId: string,
  specDigest: string,
): Promise<boolean> {
  const reread = await input.loaded.readComposedWorkflowHistory([scope], { cwd: input.cwd, gh: input.gh })
  return (
    reread.ok &&
    reread.histories[0]?.operations.some((operation) => {
      const control = operation.status === 'complete' ? operation.record : null
      if (control?.kind !== 'operator-control') return false
      const body = payload(control)
      return (
        body.control === 'accept-material' &&
        matchesRecordRef(body.mandate, scope, input.mandate.recordId, 'mandate') &&
        matchesRecordRef(body.predecessor, scope, predecessor.recordId, predecessor.kind) &&
        matchesRecordRef(body.assessment, scope, assessmentId, 'action-receipt') &&
        body.specDigest === specDigest
      )
    }) === true
  )
}
