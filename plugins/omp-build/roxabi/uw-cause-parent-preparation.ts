import { randomUUID } from 'node:crypto'
import {
  bindExternalRef,
  type GitHubOptions,
  githubScope,
  nativeObservationDigest,
  prepareComposedParentConsent,
  readUwCompletionObservation,
} from '../dist/contracts.js'
import type { CauseCreationContext } from '../engine/cause-creation-context-schema.ts'
import type { ComposedParentConsent, ParentCoverageIntent } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwCreatePlan } from '../engine/uw-create-plan-schema.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import { defaultGh } from './feature-engine.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { hash, same } from './uw-cause-creation-support.ts'
import type { UwReadPort } from './uw-contract.ts'
import type { ProductionReaderOptions } from './uw-input-readers.ts'
import { rootObservation } from './uw-installed-observation.ts'
import type { UwNativeHost } from './uw-installed-operations.ts'
import { assessCreatedChildForParent } from './uw-parent-assessment.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

export type PreparedCauseParentAcceptance = {
  prepared: PreparedMaterialAcceptance
  consent: ComposedParentConsent
  before: Extract<UwCompletionObservation, { status: 'complete' }>
}

function verifyParentOrigin(
  input: Parameters<typeof prepareCauseParentAcceptance>[0],
  before: Extract<UwCompletionObservation, { status: 'complete' }>,
): void {
  const parentObservation = input.creation.parentObservation
  const parentNative = rootObservation(input.parent, { graph: before.graph })
  const parentHistory = before.histories.find((history) => same(history.source.scope, input.parent))
  const sourceRef = input.creation.kind === 'sister' ? input.creation.disposition : input.creation.report
  const sourceDigest = input.creation.kind === 'sister' ? input.creation.dispositionDigest : input.creation.reportDigest
  const sourceHistory = before.histories.find((history) => same(history.source.scope, sourceRef.scope))
  const source = sourceHistory === undefined ? null : bindExternalRef(sourceRef, sourceHistory)
  if (
    parentObservation === null ||
    parentObservation.state !== 'active' ||
    !same(parentObservation.parent, input.parent) ||
    parentHistory === undefined ||
    hash(parentHistory) !== parentObservation.historyDigest ||
    nativeObservationDigest({
      ...parentNative,
      labels: [...parentNative.labels],
      children: [...parentNative.children],
      blockers: [...parentNative.blockers],
    }) !== parentObservation.nativeDigest ||
    source === null ||
    !source.ok ||
    hash(source.value) !== sourceDigest
  )
    throw new Error('composed-parent-origin-stale')
  if (nativeIssueObservationDigest(rootObservation(input.origin, { graph: before.graph })) !== input.originalDigest)
    throw new Error('composed-cause-original-stale')
}

/** One real native assessment over the already-prepared #897 child; never invent a child scope. */
export async function prepareCauseParentAcceptance(input: {
  core: UwCreatePlan
  creation: CauseCreationContext
  parentCoverage: ParentCoverageIntent
  parent: Scope
  originalDigest: string
  origin: Scope
  github: GitHubOptions
  reader: UwReadPort
  host: UwNativeHost
  actionOptions: ProductionReaderOptions
  markAssessmentEffect: () => void
}): Promise<PreparedCauseParentAcceptance> {
  const relations = input.core.writes.relations
  const issues = [
    ...(relations.parent == null ? [] : [relations.parent]),
    ...relations.addChildren,
    ...relations.removeChildren,
    ...relations.addBlockers,
    ...relations.removeBlockers,
  ]
  const seeds = [input.origin, ...issues.map((issue) => githubScope(issue.repository, issue.number))]
  const gh = input.github.gh ?? defaultGh()
  const read = () =>
    readUwCompletionObservation(
      input.parent,
      input.github,
      (histories) => loadReviewClassCatalogues({ histories, cwd: input.github.cwd, gh }),
      seeds,
    )
  const before = await read()
  if (before.status !== 'complete') throw new Error('composed-parent-observation-incomplete')
  verifyParentOrigin(input, before)
  const assessment = await assessCreatedChildForParent({
    core: input.core,
    creation: input.creation,
    parentCoverage: input.parentCoverage,
    before,
    host: input.host,
    cwd: input.github.cwd,
    gh,
    actionOptions: input.actionOptions,
    reader: input.reader,
    markAssessmentEffect: input.markAssessmentEffect,
  })
  if (!assessment.ok)
    throw new Error(
      `composed-parent-assessment-refused: ${assessment.diagnostics.map((item) => `${item.code}: ${item.message}`).join(',')}`,
    )
  const after = await read()
  if (after.status !== 'complete') throw new Error('composed-parent-observation-incomplete-after-assessment')
  const history = after.histories.find(
    (entry) =>
      entry.source.scope.repository === assessment.value.assessment.scope.repository &&
      entry.source.scope.target === assessment.value.assessment.scope.target,
  )
  if (history === undefined) throw new Error('composed-parent-assessment-history-missing')
  const result = bindExternalRef(assessment.value.assessment, history)
  if (
    !result.ok ||
    result.value.kind !== 'action-receipt' ||
    result.value.payload.action !== 'assess-spec' ||
    result.value.payload.phase !== 'result'
  )
    throw new Error('composed-parent-assessment-result-missing')
  const mandateRef = result.value.payload.mandate
  const mandateHistory = after.histories.find(
    (entry) =>
      entry.source.scope.repository === mandateRef.scope.repository &&
      entry.source.scope.target === mandateRef.scope.target,
  )
  const mandate = mandateHistory === undefined ? null : bindExternalRef(mandateRef, mandateHistory)
  if (mandate === null || !mandate.ok || mandate.value.kind !== 'mandate')
    throw new Error('composed-parent-mandate-missing')
  const exact = result.value.payload.exactInputs
  const consent = prepareComposedParentConsent({
    material: {
      uw: input.parent,
      operationId: randomUUID(),
      histories: after.histories,
      mandate: mandate.value,
      currentProposed: exact.proposed,
      identityAllocations: exact.identityAllocations,
    },
    beforeAssessment: before,
    observation: after,
    createOperationId: input.core.operationId,
    assessment: assessment.value.assessment,
  })
  if (!consent.ok)
    throw new Error(`composed-parent-consent-refused: ${consent.diagnostics.map((item) => item.code).join(',')}`)
  return { ...consent.value, before: after }
}
