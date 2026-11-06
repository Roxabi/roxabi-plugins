import { canonicalValueDigest } from '../engine/action-input.ts'
import { evidenceDigest } from '../engine/criterion-admission.ts'
import { criterionVerdictSchema } from '../engine/criterion-verdict-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
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

function verdictReferences(
  context: IntegrationContext,
  scope: Scope,
  mandate: MandateRecord,
  admitted: AdmittedIntegration,
) {
  const metadata = coverageReference(scope, mandate, admitted)
  const omitted = scope.target === context.middle.target && context.scenarioName === 'middle-missing-coverage'
  return [...(omitted ? [] : [metadata]), ...childReferences(admitted)]
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
