import { assessUwAdmission } from '../dist/contracts.js'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { mandatesInHistory } from './feature-context.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { bindsOwnPause, inhibition } from './feature-control.ts'
import { assembleChantier, sameDeliveryCoordinates } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'
import type { FeatureObservation, FreshUwDeliveryAdmission } from './feature-observation-contract.ts'
import { readObservationDecisions } from './feature-review-observation.ts'
import { reconcileWithdrawalContexts } from './fix-uw-histories.ts'
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
  let observation = await assembleObservationBase(control, selected, intent)
  if ('kind' in observation) return observation
  const barriers: WithdrawalBarrier[] = []
  const decisions = await readObservationDecisions(selected, observation, barriers)
  if ('kind' in decisions) return decisions
  if (barriers.length > 0) {
    const scope = observation.delivery?.scope
    if (scope === undefined) return { kind: 'blocked', reason: 'fix-history-observation-drift' }
    const refreshed = await assembleObservationBase(control, selected, intent)
    if ('kind' in refreshed) return refreshed
    if (!sameDeliveryCoordinates(observation.delivery, refreshed.delivery) || observation.merged !== refreshed.merged)
      return { kind: 'blocked', reason: 'delivery-observation-drift' }
    const reconciled = reconcileWithdrawalContexts(
      observation.evidence.causal,
      refreshed.evidence.causal,
      scope,
      barriers,
    )
    if (!reconciled.ok) return { kind: 'blocked', reason: reconciled.diagnostics[0] ?? 'fix-history-observation-drift' }
    refreshed.facts.failedChecks = observation.facts.failedChecks
    refreshed.facts.evidenceDigest = observation.facts.evidenceDigest
    observation = refreshed
  }
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

/** The latest read before any decision; a held framing aggregate stops every transition here. */
async function observedCurrentRead(
  selected: SelectedFeature,
  uwRead: UwRead | null,
  observation: Parameters<typeof createInstalledObservedUwReadPort>[0]['observation'],
): Promise<{ read: UwRead | null } | ContinueFeatureResult> {
  if (uwRead === null) return { read: null }
  const read = await createInstalledObservedUwReadPort({ observation }).readUw(selected.authority.scope)
  const aggregate = read.admission.aggregate
  if (aggregate.status === 'held')
    return { kind: 'blocked', reason: aggregate.code, diagnostics: aggregate.diagnostics }
  return { read }
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
  const requirements = observationRequirements(selected)
  const effectiveConfig = effectiveWorkflowConfig(context.engine.shippedProductVersion(), requirements)
  const merged = delivery !== null && (await pullRequestMerged(context.gh, context.cwd, delivery.number))
  const current = await observedCurrentRead(selected, uwRead, evidence.causal.observation)
  if ('kind' in current) return current
  const currentRead = current.read
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
function observationRequirements(selected: SelectedFeature): string[] {
  if (selected.mandate !== null) return mandateRequirements(selected.mandate.payload.config)
  const { context, selection, history, scope } = selected.authority
  if (
    selection.status !== 'refused' ||
    selection.reason !== 'paused' ||
    !bindsOwnPause(context.engine, selection, history, scope)
  ) {
    return []
  }
  const mandate = mandatesInHistory(history).find(
    (candidate) => candidate.recordId === selection.pause.mandate.recordId,
  )
  return mandateRequirements(mandate?.payload.config)
}

function mandateRequirements(config: unknown): string[] {
  if (!isRecord(config)) return []
  return additionalRequirementsOf(config.effective)
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
