import { assessUwAdmission, effectiveMandateRole } from '../dist/contracts.js'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { NativeSelector, SpecializedDecisions, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import { epicStep } from '../skills/feature/epic-driver.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { inhibition } from './feature-control.ts'
import { assembleChantier } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'
import type { FeatureObservation, FreshUwDeliveryAdmission } from './feature-observation-contract.ts'
import { readReviewObservation } from './feature-review-observation.ts'
import type { UwRead } from './uw-contract.ts'
import { readAssessmentSpecFacts, readCurrentOwnSpecFacts } from './uw-current-facts.ts'
import { createInstalledObservedUwReadPort, UwGraphUnavailableError } from './uw-read-port.ts'
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

async function currentSpecFacts(
  selected: SelectedFeature,
  read: UwRead | null,
  causal: WorkflowCausalContext,
  intent: Pick<ContinueFeatureInput, 'parentCoverage' | 'parentCoverageBasis'>,
): Promise<CurrentSpecObservation | ContinueFeatureResult> {
  if (selected.reader === null || read === null)
    return { currentSpec: null, identityAllocations: null, deliveryAdmission: null }
  if (!read.identity.ok) return unavailable(read.identity.diagnostics)
  if (intent.parentCoverage !== undefined && intent.parentCoverageBasis === undefined)
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  const facts =
    read.accepted.status === 'accepted'
      ? await readAssessmentSpecFacts({
          uw: selected.authority.scope,
          read,
          coverage: intent.parentCoverage,
          basis: intent.parentCoverageBasis,
        })
      : await readCurrentOwnSpecFacts({ uw: selected.authority.scope, read })
  if (!facts.ok && 'coverageRequest' in facts)
    return { kind: 'blocked', reason: facts.reason, coverageRequest: facts.coverageRequest }
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
    histories: causal.histories,
    catalogues: causal.catalogues,
    completion: read.completion,
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
  intent: Pick<ContinueFeatureInput, 'parentCoverage' | 'parentCoverageBasis'> = {},
): Promise<FeatureObservation | ContinueFeatureResult> {
  const observation = await assembleObservationBase(control, selected, intent)
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
async function readObservationUw(selected: SelectedFeature): Promise<UwRead | null | ContinueFeatureResult> {
  if (selected.reader === null) return null
  try {
    return await selected.reader.readUw(selected.authority.scope)
  } catch (error) {
    if (error instanceof UwGraphUnavailableError)
      return { kind: 'blocked', reason: 'uw-graph-unavailable', diagnostics: error.diagnostics }
    throw error
  }
}

function commonCompletion(read: UwRead | null, scope: { repository: string; target: string }): boolean {
  if (read === null || read.observation.status !== 'complete') return false
  return read.completion.completions.get(`${scope.repository}\0${scope.target}`)?.state === 'complete'
}

async function assembleObservationBase(
  control: FeatureControl,
  selected: SelectedFeature,
  intent: Pick<ContinueFeatureInput, 'parentCoverage' | 'parentCoverageBasis'>,
): Promise<ObservationBase | ContinueFeatureResult> {
  const { authority, mandate, acceptedSpec } = selected
  const { context, target, history, scope, onPrincipal, identity } = authority
  const uwRead = await readObservationUw(selected)
  if (uwRead !== null && 'kind' in uwRead) return uwRead
  const assembled = await assembleChantier(context.engine, target, history, mandate, acceptedSpec, uwRead, {
    cwd: context.cwd,
    gh: context.gh,
  })
  if (!assembled.ok) return { kind: 'blocked', reason: assembled.reason, diagnostics: assembled.diagnostics }
  const { evidence, delivery } = assembled
  const head = delivery?.head ?? null
  const requirements = mandateRequirements(mandate?.payload.config)
  const effectiveConfig = effectiveWorkflowConfig(context.engine.shippedProductVersion(), requirements)
  const merged = delivery !== null && (await pullRequestMerged(context.gh, context.cwd, delivery.number))
  const currentRead =
    uwRead === null
      ? null
      : await createInstalledObservedUwReadPort({ observation: evidence.causal.observation }).readUw(
          selected.authority.scope,
        )
  const completedDelivery = merged && commonCompletion(currentRead, selected.authority.scope)
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const currentFacts = await currentSpecFacts(selected, currentRead, evidence.causal, intent)
  if ('kind' in currentFacts) return currentFacts
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
      endObligationsMet: completedDelivery,
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
    currentSpec.children.every((child) => 'scope' in child) &&
    JSON.stringify(currentSpec.snapshot.spec) === JSON.stringify(acceptedSpec.snapshot.spec) &&
    currentSpec.tier === acceptedSpec.tier &&
    JSON.stringify(canonicalChildren(currentSpec.children.filter((child) => 'scope' in child))) ===
      JSON.stringify(canonicalChildren(acceptedSpec.children)) &&
    JSON.stringify(currentSpec.inheritedOwnSpecRefs) === JSON.stringify(acceptedSpec.inheritedOwnSpecRefs) &&
    JSON.stringify(currentSpec.coverage) === JSON.stringify(acceptedSpec.coverage)
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
