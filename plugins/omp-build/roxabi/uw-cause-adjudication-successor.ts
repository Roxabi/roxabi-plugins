import { createHash } from 'node:crypto'
import {
  assessCauseDispositions,
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
} from '../dist/contracts.js'
import type { CauseAdjudicationInput, CauseAdjudicationProposal } from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { CauseRead } from './uw-cause-read.ts'
import type { CauseOperationResult } from './uw-contract.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function diagnostics(uw: Scope, errors: readonly { code: string; message?: string }[]): UwDiagnostic[] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message ?? error.code,
    location: { kind: 'native', uw, connection: 'state' },
    related: [],
  }))
}
function resolveDecision(fresh: CauseRead, histories: readonly DecodedHistory[]) {
  const subject = fresh.disposition.payload.subject
  if (subject.kind !== 'cause') return { ok: false as const, code: 'cause-subject-not-runnable' }
  const sourceHistory = histories.find(
    (history) =>
      history.source.scope.repository === subject.decision.scope.repository &&
      history.source.scope.target === subject.decision.scope.target,
  )
  if (!sourceHistory) return { ok: false as const, code: 'cause-history-missing' }
  const decision = bindExternalRef(subject.decision, sourceHistory)
  if (!decision.ok || decision.value.kind !== 'decision')
    return { ok: false as const, code: 'cause-decision-unconfirmed' }
  return { ok: true as const, value: decision.value }
}

function adjudicationsOf(history: DecodedHistory) {
  return history.operations.flatMap((operation) =>
    operation.status === 'complete' &&
    operation.authority !== 'foreign' &&
    operation.record?.kind === 'cause-operation' &&
    operation.record.payload.proposal.operation === 'adjudicate-cause'
      ? [operation.record]
      : [],
  )
}

export async function publishAdjudicationSuccessor(args: {
  input: { github: GitHubOptions }
  fresh: CauseRead
  uw: Scope
  intent: { value: Extract<CanonicalRecord, { kind: 'cause-operation' }> }
  request: CauseAdjudicationInput
  proposal: CauseAdjudicationProposal
}): Promise<CauseOperationResult> {
  const { input, fresh, uw, intent, request, proposal } = args
  const loaded = await readComposedWorkflowHistory(
    fresh.histories.map((history) => history.source.scope),
    input.github,
  )
  if (!loaded.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, loaded.diagnostics) }
  const newHome = loaded.histories.find(
    (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
  )
  if (!newHome) return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: 'cause-history-missing' }]) }
  const operationRef = { scope: uw, recordId: intent.value.recordId, kind: 'cause-operation' as const }
  const bound = bindExternalRef(operationRef, newHome)
  if (!bound.ok || bound.value.kind !== 'cause-operation' || digest(bound.value) !== digest(intent.value))
    return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: 'cause-operation-unconfirmed' }]) }
  const decision = resolveDecision(fresh, loaded.histories)
  if (!decision.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: decision.code }]) }
  const adjudications = adjudicationsOf(newHome)
  const assessed = assessCauseDispositions({
    context: fresh.context,
    source: { kind: 'decision', decision: decision.value },
    histories: loaded.histories,
    adjudications,
  })
  if (!assessed.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, assessed.diagnostics) }
  const successor = assessed.value.outcomes.filter(
    (outcome) =>
      outcome.previous?.recordId === request.pending.recordId &&
      outcome.adjudication?.recordId === operationRef.recordId,
  )
  if (successor.length !== 1 || successor[0] === undefined)
    return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: 'cause-successor-unconfirmed' }]) }
  const record = buildRecord({
    ...uw,
    version: 1,
    kind: 'cause-disposition',
    recordId: `${proposal.operationId}:disposition`,
    runId: proposal.operationId,
    operationId: `${proposal.operationId}:disposition`,
    payload: successor[0],
  })
  if (!record.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, record.diagnostics) }
  const written = await publishConfirmedWorkflowRecord(
    record.value,
    newHome,
    input.github,
    null,
    loaded.histories.filter((history) => history !== newHome),
  )
  if (written.status !== 'confirmed')
    return { status: 'partial', uw, diagnostics: diagnostics(uw, written.diagnostics) }
  return {
    status: 'adjudicated',
    disposition: { scope: uw, recordId: record.value.recordId, kind: 'cause-disposition' },
  }
}
