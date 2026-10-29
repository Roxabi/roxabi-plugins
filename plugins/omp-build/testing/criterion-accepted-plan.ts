import { actionInputDigest } from '../engine/action-input.ts'
import {
  CRITERION_EVIDENCE_FORMAT,
  criterionDeclarationSchema,
  criterionEvidenceSchema,
} from '../engine/criterion-evidence-schema.ts'
import { FINDING_TARGET_FORMAT } from '../engine/finding-target-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { resolveOwnSpecEffective } from '../engine/spec-effective.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord } from '../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { admittedImplement, eligiblePlan } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

function criterionPlanAndImplementation(
  mandate: MandateRecord,
  actionId: string,
  implementation: ReceiptRecord,
  accepted?: AcceptedOwnSpec,
): CanonicalRecord[] {
  const workflow = roxabiWorkflowFixtures()
  const start = workflow.implementStart(mandate, actionId)
  if (accepted === undefined) return [...eligiblePlan(mandate), start, implementation]
  const digest = workflow.publishedPlanDigest()
  const effective = resolveOwnSpecEffective(accepted)
  if (!effective.ok) throw new Error('Fixture accepted Spec is not effective')
  const records: CanonicalRecord[] = [
    ...workflow.planDraftRecords(mandate, 'act-plan-1', accepted.ref.version),
    workflow.planReviewStart(mandate, 'act-plan-1', digest, 'act-plan-review-1', accepted.ref.version),
    workflow.planReviewRecord(
      mandate,
      'act-plan-1',
      digest,
      [
        workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      'act-plan-review-1',
      accepted.ref.version,
    ),
    start,
    implementation,
  ]
  return records.map((record): CanonicalRecord => {
    if (record.kind !== 'action-receipt') return record
    const prior = record.payload.inputs
    const manifest = { ...prior.manifest, spec: { kind: 'accepted' as const, effective: effective.value } }
    return {
      ...record,
      payload: { ...record.payload, inputs: { ...prior, manifest, fingerprint: actionInputDigest(manifest) } },
    } as CanonicalRecord
  })
}

/** Fictional captured execution, exclusively for exercising the real admission path in tests. */
export function criterionImplementationRecords(
  mandate: MandateRecord,
  head: string,
  accepted?: AcceptedOwnSpec,
): CanonicalRecord[] {
  const criterion = (accepted?.snapshot ?? mandate.payload.ownSpec.snapshot).spec.criteria.find(({ id }) => id === 'C1')
  if (criterion === undefined) throw new Error('Fixture mandate has no C1 criterion')
  const result = admittedImplement(mandate)
  if (
    result.kind !== 'action-receipt' ||
    result.payload.action !== 'implement' ||
    result.payload.phase !== 'result' ||
    result.payload.structured === null ||
    result.payload.admission === null
  ) {
    throw new Error('Fixture implementation result is incomplete')
  }
  const code = { repository: mandate.repository, commit: head }
  const target = {
    format: FINDING_TARGET_FORMAT,
    kind: 'criterion',
    spec: accepted?.ref ?? {
      uw: mandate.payload.ownSpec.uw,
      version: mandate.payload.ownSpec.version,
      sourceAccepted: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' },
    },
    id: criterion.id,
  }
  const toolCallId = 'fixture-c1-test'
  const command = 'bun test fixture-c1.test.ts'
  const text = 'PASS C1 fixture scenario'
  const evidence = criterionEvidenceSchema.parse({
    format: CRITERION_EVIDENCE_FORMAT,
    id: 'fixture-c1-evidence',
    target,
    code,
    provenance: {
      kind: 'native',
      actionId: result.payload.actionId,
      childId: 'fixture-c1-child',
      submissionIndex: 0,
      toolCallIds: [toolCallId],
    },
    method: 'test',
    scenario: criterion.statement,
    before: null,
    after: {
      run: {
        toolCallId,
        command,
        exitCode: 0,
        output: { kind: 'combined', text },
        context: { probeCwd: '.', start: null, end: null },
      },
      versionClaim: { code, reason: 'fixture run at candidate head', references: [] },
    },
  })
  const implementation: ReceiptRecord = {
    ...result,
    payload: {
      ...result.payload,
      structured: {
        ...result.payload.structured,
        commitSHAs: [head],
        criteria: [criterionDeclarationSchema.parse({ target, verification: 'evidence', evidence: [evidence] })],
      },
      native: {
        ...result.payload.native,
        bashCalls: [{ toolCallId, input: { command }, effectiveCwd: '.', result: { output: text }, exitCode: 0 }],
      },
      admission: {
        ...result.payload.admission,
        admitted: true,
        commits: [head],
        remoteBranch: mandate.payload.branch,
        remoteTip: head,
        reason: 'admitted',
      },
    },
  }
  return criterionPlanAndImplementation(mandate, result.payload.actionId, implementation, accepted)
}
