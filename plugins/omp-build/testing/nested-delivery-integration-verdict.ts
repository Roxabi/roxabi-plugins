import { canonicalValueDigest } from '../engine/action-input.ts'
import { evidenceDigest } from '../engine/criterion-admission.ts'
import { criterionVerdictSchema } from '../engine/criterion-verdict-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { selectedReviewOperations, summarizeReviews } from '../engine/review-state.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { sourceRef } from '../roxabi/uw-action-observe.ts'
import type { IntegrationContext } from './nested-delivery-integration.ts'
import type { AdmittedIntegration } from './nested-delivery-integration-admission.ts'

function coverageReference(scope: Scope, mandate: MandateRecord, admitted: AdmittedIntegration) {
  return {
    source: 'record' as const,
    record: { scope, kind: 'mandate' as const, recordId: mandate.recordId },
    selector: '/payload/coverage/assignments/0',
    digest: canonicalValueDigest(admitted.assignment),
  }
}

function childReferences(admitted: AdmittedIntegration) {
  return admitted.childCompletion.sources.map((source) => {
    const pin = sourceRef(admitted.observation.histories, source)
    if (!pin.ok) throw new Error('Child proof source unavailable')
    return pin.value
  })
}

function withoutChildDeliveryAuthority(admitted: AdmittedIntegration) {
  const child = admitted.childCompletion.uw
  const history = admitted.observation.histories.find(
    (item) => item.source.scope.repository === child.repository && item.source.scope.target === child.target,
  )
  if (!history) throw new Error('Child review history unavailable')
  const external = admitted.observation.histories.filter((item) => item !== history)
  const summary = summarizeReviews(history, admitted.after.catalogues, null, external)
  if (!summary.ok || summary.value.reviewId === null) throw new Error('Child selected review unavailable')
  const operations = selectedReviewOperations(history, summary.value)
  if (!operations) throw new Error('Child selected review closure unavailable')
  const selected = new Set(operations.flatMap((operation) => (operation.record ? [operation.record.recordId] : [])))
  const integrationIds = new Set(
    recordsOf(history)
      .filter((record) => record.kind === 'action-receipt' && record.payload.action === 'integrate')
      .map((record) => record.recordId),
  )
  return childReferences(admitted).filter(
    (pin) =>
      pin.record.scope.repository !== child.repository ||
      pin.record.scope.target !== child.target ||
      pin.record.kind === 'mandate' ||
      (!selected.has(pin.record.recordId) && !integrationIds.has(pin.record.recordId)),
  )
}

function verdictReferences(
  context: IntegrationContext,
  scope: Scope,
  mandate: MandateRecord,
  admitted: AdmittedIntegration,
) {
  const metadata = coverageReference(scope, mandate, admitted)
  const omitted = scope.target === context.middle.target && context.scenarioName === 'middle-missing-coverage'
  const child =
    context.scenarioName === 'root-missing-child-proof' && scope.target !== context.middle.target
      ? withoutChildDeliveryAuthority(admitted)
      : childReferences(admitted)
  return [...(omitted ? [] : [metadata]), ...child]
}

function codeLink(references: ReturnType<typeof verdictReferences>) {
  return {
    method: 'test',
    after: { support: 'supported', reason: 'captured test and accepted child', references },
    before: null,
  }
}

function examined(admitted: AdmittedIntegration, references: ReturnType<typeof verdictReferences>) {
  const evidence = {
    receipt: admitted.ref,
    evidenceId: admitted.evidence.id,
    digest: evidenceDigest(admitted.evidence),
  }
  return {
    evidence,
    truth: 'supported',
    applicability: 'applies',
    codeLink: codeLink(references),
    reason: 'reviewed integration',
  }
}

function verdictRow(admitted: AdmittedIntegration, references: ReturnType<typeof verdictReferences>) {
  return criterionVerdictSchema.parse({
    target: admitted.target,
    verdict: 'satisfied',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [examined(admitted, references)],
    reason: 'direct evidence and coverage agree',
  })
}

export function integrationVerdict(
  context: IntegrationContext,
  scope: Scope,
  mandate: MandateRecord,
  admitted: AdmittedIntegration,
) {
  return verdictRow(admitted, verdictReferences(context, scope, mandate, admitted))
}
