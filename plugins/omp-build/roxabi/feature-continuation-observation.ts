import type { NativeSelector, SpecializedDecisions } from '../engine/workflow-reconstruction-types.ts'
import { epicStep } from '../skills/feature/epic-driver.ts'
import type { ProofConfigPin } from '../skills/feature/proof-base.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { inhibition } from './feature-control.ts'
import { assembleChantier } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { readReviewObservation } from './feature-review-observation.ts'
import { mandateRoleOf } from './feature-selection.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { SUPPORTED_CONFIG_VERSIONS, WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { additionalRequirementsOf } from './workflow-overrides.ts'
import { readProofConfigPins } from './workflow-pins.ts'

type ObservationBase = Omit<FeatureObservation, 'decisions' | 'reviewId'> & { merged: boolean }

export async function readFeatureObservation(
  control: FeatureControl,
  selected: SelectedFeature,
): Promise<FeatureObservation | ContinueFeatureResult> {
  const observation = await assembleObservationBase(control, selected)
  if ('kind' in observation) return observation
  const decisions = await readObservationDecisions(selected, observation)
  if ('kind' in decisions) return decisions
  return {
    evidence: observation.evidence,
    delivery: observation.delivery,
    facts: observation.facts,
    decisions,
    reviewId: decisions.reviewId,
  }
}
async function assembleObservationBase(
  control: FeatureControl,
  selected: SelectedFeature,
): Promise<ObservationBase | ContinueFeatureResult> {
  const { authority, mandate, issue } = selected
  const { context, target, history, scope, onPrincipal, identity } = authority
  const assembled = await assembleChantier(context.engine, target, history, mandate, {
    cwd: context.cwd,
    gh: context.gh,
  })
  if (!assembled.ok) return { kind: 'blocked', reason: assembled.reason }
  const { evidence, delivery } = assembled
  const head = delivery?.head ?? null
  const proofPins = await readPins(context.git, context.cwd, head)
  if ('kind' in proofPins) return proofPins
  const requirements = mandateRequirements(mandate?.payload.config)
  const effectiveConfig = effectiveWorkflowConfig(context.engine.shippedProductVersion(), requirements)
  const merged = delivery !== null && (await pullRequestMerged(context.gh, context.cwd, delivery.number))
  const ordinaryMergedDelivery =
    merged && mandateRoleOf(mandate) === 'feature' && !isRecord(mandate?.payload.parent ?? null)
  const sessionCwd = identity.ok ? identity.sessionTop : null
  return {
    evidence,
    delivery,
    merged,
    facts: {
      specDigest: context.engine.specDigest(issue.body),
      specBody: issue.body,
      branch: delivery?.branch ?? null,
      base: delivery?.base ?? null,
      candidateGitSHA: head,
      lineageHead: head,
      pullRequest:
        delivery === null
          ? null
          : {
              scope: delivery.scope,
              head: delivery.head,
              base: delivery.base,
              associatedIssue: delivery.issueScope,
            },
      merged,
      sessionCwd: onPrincipal ? null : sessionCwd,
      preparedWorktree: onPrincipal ? null : sessionCwd,
      productVersion: context.engine.shippedProductVersion(),
      configVersion: WORKFLOW_CONFIG_VERSION,
      configDigest: configPinDigest(effectiveConfig),
      supportedConfigVersions: SUPPORTED_CONFIG_VERSIONS,
      proofPins,
      explicitSelection: control === 'select' || control === 'new',
      explicitResume: control === 'resume',
      successorAntecedent: null,
      endObligationsMet: ordinaryMergedDelivery,
      localInhibit: inhibition(scope) ?? null,
      failedChecks: null,
      evidenceDigest: null,
    },
  }
}
function mandateRequirements(config: unknown): string[] {
  if (!isRecord(config)) return []
  return additionalRequirementsOf(config.effective)
}
async function readObservationDecisions(
  selected: SelectedFeature,
  observation: ObservationBase,
): Promise<(SpecializedDecisions & { reviewId: string | null }) | ContinueFeatureResult> {
  const { authority, mandate, number } = selected
  const { context, target } = authority
  const { delivery, facts, merged } = observation
  const review = await readReviewObservation(delivery, merged, context)
  if (isContinuationResult(review)) return review
  facts.failedChecks = review.failedChecks
  facts.evidenceDigest = review.evidenceDigest
  const epic = await readEpicStep(target, mandate, context.cwd, number)
  if (isContinuationResult(epic)) return epic
  return buildSpecializedDecisions({
    reviewStep: review.review,
    reviewId: review.reviewId,
    epicStep: epic,
    ciWatchStatus: merged ? null : review.ciWatchStatus,
    pullRequestOpen: delivery !== null,
  })
}

function isContinuationResult(value: unknown): value is ContinueFeatureResult {
  return value !== null && typeof value === 'object' && 'kind' in value
}

async function readPins(
  git: SelectedFeature['authority']['context']['git'],
  cwd: string,
  head: string | null,
): Promise<readonly ProofConfigPin[] | ContinueFeatureResult> {
  if (head === null) return []
  try {
    return await readProofConfigPins(git, cwd, head)
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'proof-pin-unreadable' }
  }
}

async function readEpicStep(
  target: SelectedFeature['authority']['target'],
  mandate: SelectedFeature['mandate'],
  cwd: string,
  number: number,
): Promise<SpecializedDecisions['epicStep'] | ContinueFeatureResult> {
  if (target.status !== 'issue' || mandateRoleOf(mandate) !== 'epic') return null
  try {
    return (await epicStep(cwd, number)).name
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'blocked', reason: 'epic-step-failed', diagnostics: [{ code: 'epic-step-failed', message }] }
  }
}

async function pullRequestMerged(
  gh: SelectedFeature['authority']['context']['gh'],
  cwd: string,
  number: number,
): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await gh(cwd, ['pr', 'view', String(number), '--json', 'state']))
    return isRecord(parsed) && parsed.state === 'MERGED'
  } catch {
    return false
  }
}
function buildSpecializedDecisions(input: {
  reviewStep: SpecializedDecisions['reviewStep']
  reviewId: string | null
  epicStep: SpecializedDecisions['epicStep']
  ciWatchStatus: SpecializedDecisions['ciWatchStatus']
  pullRequestOpen: boolean
}): SpecializedDecisions & { reviewId: string | null } {
  const absent = (status: NativeSelector['status'] = 'absent'): NativeSelector => ({ status, evidence: [] })
  return {
    reviewStep: input.reviewStep,
    reviewId: input.reviewId,
    epicStep: input.epicStep,
    epicLand: null,
    ciWatchStatus: input.ciWatchStatus,
    publish: absent(input.pullRequestOpen ? 'published' : 'absent'),
    landing: absent(),
    watch: absent(),
  }
}
