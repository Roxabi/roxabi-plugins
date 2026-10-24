import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { readDecodedHistory } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, isRecord } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { mandateRoleOf } from './feature-selection.ts'
import { admitAttributedCiCorrection } from './fix-ci-admission.ts'
import { acceptedSpecOf, boundCorrection } from './fix-mandate-resolution.ts'
import { classifyCiCorrectionStep } from './fix-mandate-types.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { GitRunner } from './workflow-pins.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>

/**
 * Emit admitted-ci-correction only when admitAttributedCiCorrection returns attributed-correction.
 * attributionRecordId = attribute-ci result receipt id (not start).
 * scope = resolveAcceptedSpec(...).spec.body (not exactInputs.scope / evidence path).
 * reference = `#${pr}` for resolveExplicit — not a differing feature issue subject.
 */
export async function tryAdmittedCiCorrectionContinuation(input: {
  cwd: string
  history: History
  mandateHistory?: History
  parents: readonly History[]
  scope: Scope
  head: string | null
  branch: string | null
  base: string | null
  pr: number
  gh: Gh
  ciFailed: boolean
  resolveAcceptedSpec: Contracts['resolveAcceptedSpec']
  selectApplicableMandate: Contracts['selectApplicableMandate']
}): Promise<ContinueFeatureResult | null | { kind: 'blocked'; reason: string }> {
  if (!input.ciFailed || input.head === null || !/^[0-9a-f]{40}$/.test(input.head)) return null
  const decoded = await readDecodedHistory(input.scope, input.cwd, input.gh)
  if (!decoded.ok) return { kind: 'blocked', reason: decoded.reason }
  const attributionRecordId = latestAttributeCiChangeReceiptId(decoded.history, input.head, input.scope)
  if (attributionRecordId === null) return null
  const mandateHistory = input.mandateHistory ?? input.history
  const selected = input.selectApplicableMandate(mandateHistory, input.parents)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { kind: 'blocked', reason: 'mandate-missing' }
  }
  const accepted = input.resolveAcceptedSpec(selected.mandate, [mandateHistory, ...input.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const correctionScope = accepted.spec.body
  if (correctionScope.trim().length === 0) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  // The fresh decoded history above is both receipt selection and correction admission evidence.
  const admitted = await admitAttributedCiCorrection({
    cwd: input.cwd,
    target: {
      repository: input.scope.repository,
      target: input.scope.target,
      number: input.pr,
      kind: 'pull-request',
      state: 'open',
      candidateGitSHA: input.head,
    },
    scope: correctionScope,
    branch: input.branch,
    base: input.base,
    attributionRecordId,
    workflow: {
      nextReviewStep: (cwd: string, pr: number, options: { ciFailed?: boolean; reviewing?: boolean }) =>
        nextReviewStep(cwd, pr, { ...options, gh: input.gh }),
    },
    options: withRoxabiGitHubPolicy({ cwd: input.cwd, gh: input.gh }),
    readHistory: async () => decoded.history,
  })
  if (!admitted.ok) return { kind: 'blocked', reason: admitted.diagnostics[0] ?? 'ci-attribution-unconfirmed' }
  if (admitted.value.status === 'spent') {
    return { kind: 'terminal', reason: admitted.value.reason }
  }
  if (admitted.value.status === 'unsafe') {
    return { kind: 'blocked', reason: admitted.value.reason }
  }
  if (admitted.value.status !== 'attributed-correction') return null
  return {
    kind: 'admitted-ci-correction',
    reference: `#${input.pr}`,
    attributionRecordId: admitted.value.attributionRecordId,
    scope: admitted.value.scope,
  }
}

export async function continueReviewBoundFix(
  selected: SelectedFeature,
  observation: FeatureObservation,
): Promise<ContinueFeatureResult> {
  const { delivery } = observation
  if (delivery === null || delivery.head === null) return { kind: 'blocked', reason: 'review-fix-pull-request-missing' }
  if (observation.reviewId === null) return { kind: 'blocked', reason: 'review-fix-review-missing' }
  if (selected.mandate === null || selected.mandateRef === null)
    return { kind: 'blocked', reason: 'review-fix-mandate-missing' }
  if (mandateRoleOf(selected.mandate) !== 'feature') return { kind: 'blocked', reason: 'review-fix-mandate-role' }
  const current = acceptedSpecOf(selected.mandate, [observation.evidence.issue, ...observation.evidence.parents])
  if (!current.ok) return { kind: 'blocked', reason: current.diagnostics[0] ?? 'review-fix-spec-unreadable' }
  const bound = boundCorrection(
    {
      target: {
        repository: delivery.scope.repository,
        target: delivery.scope.target,
        number: delivery.number,
        kind: 'pull-request',
        state: 'open',
        candidateGitSHA: delivery.head,
      },
      branch: delivery.branch,
      base: delivery.base,
    },
    [delivery.history, observation.evidence.issue, ...observation.evidence.parents],
    current.value,
  )
  if (!bound.ok) return { kind: 'blocked', reason: bound.diagnostics[0] ?? 'review-fix-binding-unreadable' }
  if (bound.value.status !== 'applicable') return { kind: 'blocked', reason: 'review-fix-binding-missing' }
  if (
    bound.value.recordId !== selected.mandateRef.recordId ||
    bound.value.body.trim().length === 0 ||
    bound.value.body.length > 4_000
  )
    return { kind: 'blocked', reason: 'review-fix-binding-refused' }
  return {
    kind: 'fix',
    reference: `#${delivery.number}`,
    reviewId: observation.reviewId,
    scope: bound.value.body,
    requiredFeatureMandate: { ...selected.mandateRef, kind: 'mandate' },
  }
}

/** Returns the actual CI correction result/refusal after observation facts are available. */
export async function continueCiCorrection(
  authority: FeatureAuthority,
  observation: FeatureObservation,
): Promise<ContinueFeatureResult> {
  const { context } = authority
  const delivery = observation.delivery
  if (delivery === null) return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
  const admitted = await tryAdmittedCiCorrectionContinuation({
    cwd: context.cwd,
    history: delivery.history,
    mandateHistory: observation.evidence.issue,
    parents: observation.evidence.parents,
    scope: delivery.scope,
    head: delivery.head,
    branch: delivery.branch,
    base: delivery.base,
    pr: delivery.number,
    gh: context.gh,
    ciFailed: observation.facts.failedChecks !== null,
    resolveAcceptedSpec: context.engine.resolveAcceptedSpec,
    selectApplicableMandate: context.engine.selectApplicableMandate,
  })
  if (admitted !== null) return admitted
  return { kind: 'blocked', reason: 'ci-attribution-unconfirmed' }
}
function matchingAttributeCiChangeReceiptId(
  operation: DecodedHistory['operations'][number] | undefined,
  head: string,
  scope: Scope,
): string | null {
  const record = operation?.record
  if (operation?.status !== 'complete' || record?.kind !== 'action-receipt') return null
  const receipt = record.payload
  if (!isRecord(receipt) || receipt.phase !== 'result' || receipt.action !== 'attribute-ci') return null
  const structured = isRecord(receipt.structured) ? receipt.structured : null
  const exact = isRecord(receipt.exactInputs) ? receipt.exactInputs : null
  if (structured?.attribution !== 'change' || exact?.candidateGitSHA !== head) return null
  const inputScope = isRecord(exact.scope) ? exact.scope : null
  if (inputScope?.repository !== scope.repository || inputScope.target !== scope.target) return null
  return record.recordId
}

export function latestAttributeCiChangeReceiptId(history: DecodedHistory, head: string, scope: Scope): string | null {
  for (let index = history.operations.length - 1; index >= 0; index -= 1) {
    const recordId = matchingAttributeCiChangeReceiptId(history.operations[index], head, scope)
    if (recordId !== null) return recordId
  }
  return null
}

export async function classifyRedCiBeforeDispatch(
  cwd: string,
  pr: number,
  gh: Gh,
  git: GitRunner,
): Promise<ContinueFeatureResult | null> {
  try {
    const step = await nextReviewStep(cwd, pr, { ciFailed: true, gh, git })
    const classified = classifyCiCorrectionStep(step)
    if (classified.status === 'spent') {
      return { kind: 'terminal', reason: classified.reason }
    }
    if (classified.status === 'unsafe') {
      return { kind: 'blocked', reason: classified.reason }
    }
    if (classified.status === 'refused' && classified.action === 'stop') {
      return { kind: 'blocked', reason: classified.reason ?? 'ci-correction-refused' }
    }
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('latest review record to approve the current head')) {
      return { kind: 'blocked', reason: 'head-unapproved' }
    }
    return { kind: 'blocked', reason: `ci-correction-step-unreadable:${message}` }
  }
}
