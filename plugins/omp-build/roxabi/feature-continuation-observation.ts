import { assessUwAdmission, effectiveMandateRole } from '../dist/contracts.js'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { NativeSelector, SpecializedDecisions, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import { epicStep } from '../skills/feature/epic-driver.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { inhibition } from './feature-control.ts'
import { assembleChantier } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'
import type { FeatureObservation, FreshUwDeliveryAdmission } from './feature-observation-contract.ts'
import { readReviewObservation } from './feature-review-observation.ts'
import type { UwRead } from './uw-contract.ts'
import { readCurrentOwnSpecFacts } from './uw-current-facts.ts'
import { UwGraphUnavailableError } from './uw-read-port.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { SUPPORTED_CONFIG_VERSIONS, WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { additionalRequirementsOf } from './workflow-overrides.ts'

type ObservationBase = Omit<FeatureObservation, 'decisions' | 'reviewId'> & { merged: boolean }

type CurrentSpecObservation = Pick<WorkflowFacts, 'currentSpec' | 'identityAllocations'> & {
  deliveryAdmission: FreshUwDeliveryAdmission
}

function unavailable(diagnostics: readonly UwDiagnostic[]): CurrentSpecObservation {
  return { currentSpec: null, identityAllocations: null, deliveryAdmission: { diagnostics } }
}

async function currentSpecFacts(selected: SelectedFeature): Promise<CurrentSpecObservation> {
  if (selected.reader === null) return { currentSpec: null, identityAllocations: null, deliveryAdmission: null }
  let read: UwRead
  try {
    read = await selected.reader.readUw(selected.authority.scope)
  } catch (error) {
    if (error instanceof UwGraphUnavailableError) return unavailable(error.diagnostics)
    throw error
  }
  if (!read.identity.ok) return unavailable(read.identity.diagnostics)
  const facts = await readCurrentOwnSpecFacts({ uw: selected.authority.scope, read, reader: selected.reader })
  const currentChildren: CurrentChildrenProjection = facts.ok
    ? {
        ok: true,
        value: facts.value.currentSpec.children.map(({ scope, specVersion, tier }) => ({ scope, specVersion, tier })),
      }
    : { ok: false, diagnostics: facts.diagnostics }
  const admission = assessUwAdmission({
    uw: selected.authority.scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    phase: 'delivery-transition',
    currentChildren,
  })
  return facts.ok
    ? { ...facts.value, deliveryAdmission: { admission } }
    : { currentSpec: null, identityAllocations: null, deliveryAdmission: { admission } }
}

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
    deliveryAdmission: observation.deliveryAdmission,
    decisions,
    reviewId: decisions.reviewId,
  }
}
async function assembleObservationBase(
  control: FeatureControl,
  selected: SelectedFeature,
): Promise<ObservationBase | ContinueFeatureResult> {
  const { authority, mandate, acceptedSpec } = selected
  const { context, target, history, scope, onPrincipal, identity } = authority
  const assembled = await assembleChantier(context.engine, target, history, mandate, acceptedSpec, {
    cwd: context.cwd,
    gh: context.gh,
  })
  if (!assembled.ok) return { kind: 'blocked', reason: assembled.reason }
  const { evidence, delivery } = assembled
  const head = delivery?.head ?? null
  const requirements = mandateRequirements(mandate?.payload.config)
  const effectiveConfig = effectiveWorkflowConfig(context.engine.shippedProductVersion(), requirements)
  const merged = delivery !== null && (await pullRequestMerged(context.gh, context.cwd, delivery.number))
  const ordinaryMergedDelivery =
    merged &&
    mandate?.kind === 'mandate' &&
    acceptedSpec !== null &&
    effectiveMandateRole(mandate.payload.role, acceptedSpec) === 'feature' &&
    !isRecord(mandate.payload.parent)
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const currentFacts = await currentSpecFacts(selected)
  return {
    evidence,
    delivery,
    merged,
    deliveryAdmission: currentFacts.deliveryAdmission,
    facts: {
      currentSpec: currentFacts.currentSpec,
      identityAllocations: currentFacts.identityAllocations,
      base: delivery?.base ?? null,
      candidateGitSHA: head,
      lineageHead: head,
      pullRequest:
        delivery === null
          ? null
          : {
              scope: delivery.scope,
              head: delivery.branch,
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
  const { authority, mandate, number, acceptedSpec } = selected
  const { context, target } = authority
  const { delivery, facts, merged } = observation
  const review = await readReviewObservation(delivery, merged, context)
  if (isContinuationResult(review)) return review
  facts.failedChecks = review.failedChecks
  facts.evidenceDigest = review.evidenceDigest
  const epic = await readEpicStep(target, mandate, acceptedSpec, facts.currentSpec, context.cwd, number)
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

function canonicalChildren(
  children: readonly { scope: { repository: string; target: string }; specVersion: string; tier: string }[],
): string[] {
  return children
    .map((child) => `${child.scope.repository}\0${child.scope.target}\0${child.specVersion}\0${child.tier}`)
    .sort()
}

function currentSpecMatchesAccepted(
  currentSpec: WorkflowFacts['currentSpec'],
  acceptedSpec: AcceptedOwnSpec | null,
): boolean {
  return (
    currentSpec !== null &&
    acceptedSpec !== null &&
    currentSpec.snapshot.spec.version === acceptedSpec.ref.version &&
    JSON.stringify(currentSpec.snapshot.spec) === JSON.stringify(acceptedSpec.snapshot.spec) &&
    currentSpec.tier === acceptedSpec.tier &&
    JSON.stringify(canonicalChildren(currentSpec.children)) === JSON.stringify(canonicalChildren(acceptedSpec.children))
  )
}

async function readEpicStep(
  target: SelectedFeature['authority']['target'],
  mandate: SelectedFeature['mandate'],
  acceptedSpec: AcceptedOwnSpec | null,
  currentSpec: WorkflowFacts['currentSpec'],
  cwd: string,
  number: number,
): Promise<SpecializedDecisions['epicStep'] | ContinueFeatureResult> {
  if (
    target.status !== 'issue' ||
    mandate?.kind !== 'mandate' ||
    acceptedSpec === null ||
    !currentSpecMatchesAccepted(currentSpec, acceptedSpec) ||
    effectiveMandateRole(mandate.payload.role, acceptedSpec) !== 'epic'
  )
    return null
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
