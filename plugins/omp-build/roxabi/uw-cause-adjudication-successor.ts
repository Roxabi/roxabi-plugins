import { createHash } from 'node:crypto'
import {
  assessAdjudicationSuccessor,
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  publishConfirmedWorkflowRecord,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
} from '../dist/contracts.js'
import type { CauseAdjudicationInput, CauseAdjudicationProposal } from '../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import { defaultGh } from './feature-engine.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { AdjudicationRead } from './uw-cause-adjudication-read.ts'
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

export async function publishAdjudicationSuccessor(args: {
  input: { github: GitHubOptions }
  fresh: AdjudicationRead
  uw: Scope
  intent: { value: Extract<CanonicalRecord, { kind: 'cause-operation' }> }
  request: CauseAdjudicationInput
  proposal: CauseAdjudicationProposal
}): Promise<CauseOperationResult> {
  const { input, fresh, uw, intent, proposal } = args
  const loaded = await readComposedWorkflowHistory(
    fresh.histories.map((history) => history.source.scope),
    input.github,
  )
  if (!loaded.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, loaded.diagnostics) }
  const closure = await readCauseHistoryClosure(loaded.histories, (needed) =>
    readComposedWorkflowHistory(needed, input.github),
  )
  if (!closure.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, closure.diagnostics) }
  const histories = closure.histories
  const catalogues = await loadReviewClassCatalogues({
    histories,
    cwd: input.github.cwd,
    gh: input.github.gh ?? defaultGh(),
  })
  const newHome = histories.find(
    (history) => history.source.scope.repository === uw.repository && history.source.scope.target === uw.target,
  )
  if (!newHome) return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: 'cause-history-missing' }]) }
  const operationRef = { scope: uw, recordId: intent.value.recordId, kind: 'cause-operation' as const }
  const bound = bindExternalRef(operationRef, newHome)
  if (!bound.ok || bound.value.kind !== 'cause-operation' || digest(bound.value) !== digest(intent.value))
    return { status: 'partial', uw, diagnostics: diagnostics(uw, [{ code: 'cause-operation-unconfirmed' }]) }
  const assessed = assessAdjudicationSuccessor({
    pending: fresh.disposition,
    operation: bound.value,
    context: fresh.context,
    histories,
    catalogues,
  })
  if (!assessed.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, assessed.diagnostics) }
  const record = buildRecord({
    ...uw,
    version: 1,
    kind: 'cause-disposition',
    recordId: `${proposal.operationId}:disposition`,
    runId: proposal.operationId,
    operationId: `${proposal.operationId}:disposition`,
    payload: assessed.value,
  })
  if (!record.ok) return { status: 'partial', uw, diagnostics: diagnostics(uw, record.diagnostics) }
  const written = await publishConfirmedWorkflowRecord(
    record.value,
    input.github,
    createPublicationContextResolver(input.github, null),
    histories.filter((history) => history !== newHome),
  )
  if (written.status !== 'confirmed')
    return { status: 'partial', uw, diagnostics: diagnostics(uw, written.diagnostics) }
  return {
    status: 'adjudicated',
    disposition: { scope: uw, recordId: record.value.recordId, kind: 'cause-disposition' },
  }
}
