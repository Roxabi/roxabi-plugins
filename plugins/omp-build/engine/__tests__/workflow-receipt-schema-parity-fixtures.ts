import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, SCOPE } from './workflow-test-support.ts'

export function fixtures() {
  const workflow = roxabiWorkflowFixtures()
  const mandate = shippedFeatureMandate()
  const ref = { scope: SCOPE, recordId: mandate.recordId, kind: 'mandate' as const }
  const accepted = mandateAssessmentState(mandate)
  const assessment = assessFixture(
    mandate,
    'schema-assessment',
    accepted,
    proposedAssessmentState(accepted, { body: 'A revised proposal' }),
    'material',
    [history([mandate])],
  )
  if (assessment.start.kind !== 'action-receipt') throw new Error('expected assessment start')
  const proposed = { kind: 'proposed' as const, uw: SCOPE, snapshot: assessment.proposed.snapshot }
  const base = acceptedActionInputs(mandate, 'frame')
  const frameManifest = { ...base.manifest, spec: proposed }
  const frameInputs = { ...base, manifest: frameManifest, fingerprint: actionInputDigest(frameManifest) }
  const normalizeManifest = { ...frameManifest, purpose: 'normalize' as const }
  const normalizeInputs = { ...base, manifest: normalizeManifest, fingerprint: actionInputDigest(normalizeManifest) }
  const observed = {
    candidateGitSHA: 'a'.repeat(40),
    scope: SCOPE,
    failures: [{ name: 'build', source: 'check-run', observationId: '1', conclusion: 'failure' }],
  }
  const evidenceDigest = failedCheckEvidenceDigest(observed)
  if (evidenceDigest === null) throw new Error('expected CI evidence digest')
  const ciExact = { ...observed, failedChecks: ['build'], evidenceDigest }
  const ciBase = acceptedActionInputs(mandate, 'attribute-ci')
  const ciManifest = { ...ciBase.manifest, operands: { action: 'attribute-ci' as const, exactInputs: ciExact } }
  const ciInputs = { ...ciBase, manifest: ciManifest, fingerprint: actionInputDigest(ciManifest) }
  const absent = { kind: 'absent' as const, reason: 'pre-mandate' as const }
  const startRef = { scope: SCOPE, recordId: 'schema-start', kind: 'action-receipt' as const }
  const resultFields = {
    phase: 'result' as const,
    start: startRef,
    native: { completion: 'completed' as const, strict: 'valid' as const, raw: null },
    structured: null,
    admission: null,
    diagnostics: [],
  }
  const common = { format: ACTION_RECEIPT_FORMAT, phase: 'start' as const, actionId: 'schema-action' }
  const frame = {
    ...common,
    action: 'frame' as const,
    mandate: ref,
    inputs: frameInputs,
    exactInputs: { specDigest: proposed.snapshot.spec.version, branch: 'feature', base: 'main' },
  }
  const preFrame = {
    ...common,
    action: 'frame' as const,
    mandate: absent,
    inputs: frameInputs,
    exactInputs: { branch: 'feature', base: 'main' },
  }
  const normalize = {
    ...common,
    action: 'normalize' as const,
    mandate: absent,
    inputs: normalizeInputs,
    exactInputs: { uw: SCOPE, bodySha256: proposed.snapshot.raw.bodySha256 },
  }
  const ci = { ...common, action: 'attribute-ci' as const, mandate: ref, inputs: ciInputs, exactInputs: ciExact }
  const pair = <T extends object>(value: T) => [value, { ...value, ...resultFields }]
  const plan = workflow.planDraftRecords(mandate)
  const planReview = workflow.planReviewStart(mandate, 'act-plan-1', workflow.publishedPlanDigest())
  const planResult = workflow.planReviewRecord(mandate, 'act-plan-1', workflow.publishedPlanDigest(), [
    workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
    workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
  ])
  const implementation = [workflow.implementStart(mandate), workflow.rejectedImplementResult(mandate)]
  const records = [...plan, planReview, planResult, ...implementation]
  const payloads = records.map((record) => {
    if (record.kind !== 'action-receipt') throw new Error('expected receipt')
    return record.payload
  })
  return {
    payloads: [
      ...pair(frame),
      ...pair(preFrame),
      assessment.start.payload,
      assessment.result.payload,
      ...payloads,
      ...pair(ci),
      ...pair(normalize),
    ],
    frame,
    preFrame,
    normalize,
    planReview,
    planResult,
    assessment,
  }
}
