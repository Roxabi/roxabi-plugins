import type { AcceptedOwnSpec, AssessSpecExact, DecodedHistory, Scope } from '../dist/contracts.js'
import { linkedIssueBinding } from './fix-checkpoint-binding.ts'
import { authorizeFixAction, evidenceDigestOf, readLiveCiEvidence, receiptFailures } from './fix-ci-evidence.ts'
import type { FixActionResult, ReviewStepResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { resolveCorrectionMandate } from './fix-mandate-resolution.ts'
import {
  type AttributedCiCorrectionInput,
  type CiCorrectionAdmission,
  type CiCorrectionBound,
  classifyCiCorrectionStep,
  completeRecord,
  objectValue,
} from './fix-mandate-types.ts'
import { extendObservedUwCausalContext } from './fix-uw-histories.ts'

export function confirmedChangeAttribution(
  history: DecodedHistory,
  recordId: string,
  head: string,
  scope: Scope,
  evidenceDigest: string,
): FixActionResult<{ evidenceDigest: string }> {
  const record = completeRecord(history, recordId)
  if (record === null) return failure('ci-attribution-unconfirmed')
  const kind: string = record.kind
  if (kind !== 'action-receipt') return failure('ci-attribution-kind-mismatch')
  const payload = objectValue(record.payload)
  const structured = objectValue(payload?.structured)
  const inputs = objectValue(payload?.exactInputs)
  const inputScope = objectValue(inputs?.scope)
  if (payload === null || payload.phase !== 'result' || payload.action !== 'attribute-ci')
    return failure('ci-attribution-not-result')
  if (structured === null || structured.attribution !== 'change') return failure('ci-attribution-not-change')
  if (
    inputs === null ||
    inputs.candidateGitSHA !== head ||
    inputs.evidenceDigest !== evidenceDigest ||
    inputScope === null ||
    inputScope.repository !== scope.repository ||
    inputScope.target !== scope.target
  ) {
    return failure('ci-attribution-stale')
  }
  const failures = receiptFailures(inputs.failures)
  if (failures === null) return failure('ci-attribution-evidence-missing')
  const recomputed = evidenceDigestOf(head, scope, failures)
  if (!recomputed.ok) return recomputed
  if (recomputed.value !== evidenceDigest) return failure('ci-attribution-stale')
  return { ok: true, value: { evidenceDigest } }
}

type CiReviewStep = FixActionResult<ReviewStepResult> | { headUnapproved: true }

async function readCiReviewStep(input: AttributedCiCorrectionInput): Promise<CiReviewStep> {
  try {
    return { ok: true, value: await input.workflow.nextReviewStep(input.cwd, input.target.number, { ciFailed: true }) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('latest review record to approve the current head')
      ? { headUnapproved: true }
      : failure(`ci-correction-step-unreadable:${message}`)
  }
}

type AttributedCiStep = { readonly reviews?: number; readonly remaining?: number }
export type ExpectedAttributedCiCorrectionInput = AttributedCiCorrectionInput & {
  expectedUw: CiCorrectionAdmission['uw']
}

function sameCorrectionUw(expected: CiCorrectionAdmission['uw'], actual: CiCorrectionAdmission['uw']): boolean {
  return (
    JSON.stringify(expected.ownSpec) === JSON.stringify(actual.ownSpec) &&
    JSON.stringify(expected.children) === JSON.stringify(actual.children)
  )
}

function correctionUw(
  currentSpec: AssessSpecExact['proposed'] & { ownSpec: AcceptedOwnSpec },
  expectedUw: CiCorrectionAdmission['uw'] | null,
): FixActionResult<CiCorrectionAdmission['uw']> {
  if (currentSpec.children.some((child) => !('scope' in child))) return failure('fix-own-uw-unsettled')
  const uw = {
    ownSpec: currentSpec.ownSpec,
    children: currentSpec.children.filter((child) => 'scope' in child),
  }
  if (expectedUw !== null && !sameCorrectionUw(expectedUw, uw)) return failure('fix-own-uw-unsettled')
  return { ok: true, value: uw }
}

async function admitBoundCiCorrection(
  input: AttributedCiCorrectionInput,
  history: DecodedHistory,
  classified: AttributedCiStep,
  expectedUw: CiCorrectionAdmission['uw'] | null,
): Promise<FixActionResult<CiCorrectionBound>> {
  const linked = await linkedIssueBinding(input.target, input.options, input.uw)
  if (!linked.ok) return linked
  if (linked.value.currentSpec === null) return failure('fix-own-uw-unsettled')
  const currentUw = correctionUw(linked.value.currentSpec, expectedUw)
  if (!currentUw.ok) return currentUw
  if (input.target.candidateGitSHA === null) return failure('ci-correction-not-pull-request')
  const head = input.target.candidateGitSHA
  const live = await readLiveCiEvidence(input, head)
  if (!live.ok) return live
  const causal = await extendObservedUwCausalContext(
    linked.value.currentSpec.causal,
    [history, ...(linked.value.history === null ? [] : [linked.value.history]), ...linked.value.externalHistories],
    input.options,
  )
  if (!causal.ok) return causal
  const mandate = await resolveCorrectionMandate({
    target: input.target,
    history,
    linkedIssueHistory: linked.value.history,
    linkedIssueScopes: [],
    externalHistories: linked.value.externalHistories,
    causal: causal.value,
    branch: linked.value.branch ?? input.branch,
    base: linked.value.base ?? input.base,
    currentSpec: linked.value.currentSpec,
    evidenceDigest: live.value.evidenceDigest,
  })
  if (!mandate.ok) return correctionMandateFailure(mandate, classified)
  if (mandate.value.status !== 'applicable' || mandate.value.execution.landing !== false) {
    return failure('ci-correction-mandate-denied')
  }
  const pullScope = { repository: input.target.repository, target: input.target.target }
  const attribution = confirmedChangeAttribution(
    history,
    input.attributionRecordId,
    head,
    pullScope,
    live.value.evidenceDigest,
  )
  if (!attribution.ok) return attribution
  const authorized = await authorizeFixAction(
    input,
    history,
    linked.value.history,
    linked.value.externalHistories,
    'fix-ci',
    live.value,
    linked.value.currentSpec.read,
  )
  if (!authorized.ok) return authorized
  return {
    ok: true,
    value: {
      status: 'attributed-correction',
      action: 'fix',
      reason: 'ci-failed',
      reviews: classified.reviews,
      remaining: classified.remaining,
      attributionRecordId: input.attributionRecordId,
      candidateGitSHA: input.target.candidateGitSHA,
      uw: currentUw.value,
      mandateRecordId: mandate.value.mandate.recordId,
      failedChecks: authorized.value,
    },
  }
}

function correctionMandateFailure(
  mandate: Extract<Awaited<ReturnType<typeof resolveCorrectionMandate>>, { ok: false }>,
  classified: AttributedCiStep,
): FixActionResult<CiCorrectionBound> {
  if (mandate.diagnostics.some((item) => item.includes('unsafe')))
    return { ok: true, value: { status: 'unsafe', reason: 'unsafe', reviews: classified.reviews } }
  return mandate
}

async function admitCiCorrection(
  input: AttributedCiCorrectionInput,
  expectedUw: CiCorrectionAdmission['uw'] | null,
): Promise<FixActionResult<CiCorrectionBound>> {
  if (input.signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  if (input.target.kind !== 'pull-request' || input.target.candidateGitSHA === null)
    return failure('ci-correction-not-pull-request')
  const readStep = await readCiReviewStep(input)
  if ('headUnapproved' in readStep) return { ok: true, value: { status: 'unsafe', reason: 'head-unapproved' } }
  if (!readStep.ok) return readStep
  const step = readStep.value
  const classified = classifyCiCorrectionStep(step)
  if (classified.status !== 'attributed-correction') return { ok: true, value: classified }
  const history = await input.readHistory()
  if (!history.source.complete) return failure('fix-history-incomplete')
  return admitBoundCiCorrection(input, history, classified, expectedUw)
}

export async function admitAttributedCiCorrection(
  input: AttributedCiCorrectionInput,
): Promise<FixActionResult<CiCorrectionBound>> {
  return admitCiCorrection(input, null)
}

export async function reAdmitAttributedCiCorrection(
  input: ExpectedAttributedCiCorrectionInput,
): Promise<FixActionResult<CiCorrectionBound>> {
  return admitCiCorrection(input, input.expectedUw)
}
