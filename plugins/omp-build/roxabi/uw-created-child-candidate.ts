import {
  type ActionOperands,
  actionOperandsSchema,
  bindExternalRef,
  canonicalValueDigest,
  capturedChildOwnSources,
  mechanicalSpecDelta,
  nativeIssueObservationFromNode,
  specDigest,
  toDiagnostics,
  type UwCompletionObservation,
} from '../dist/contracts.js'
import type { CauseCreationContext } from '../engine/cause-creation-context-schema.ts'
import type { ParentCoverageIntent } from '../engine/cause-disposition-schema.ts'
import type { Result } from '../engine/result.ts'
import type { UwCreatePlan } from '../engine/uw-create-plan-schema.ts'
import type { AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { RecordInputRef } from './uw-action-contract.ts'
import { sourceRef } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import type { UwRead } from './uw-contract.ts'
import { projectObservedChildCommitments, readCurrentOwnSpecFacts } from './uw-current-facts.ts'

export type CreatedChildAssessment = {
  core: UwCreatePlan
  creation: CauseCreationContext

  parentCoverage: ParentCoverageIntent
  before: Extract<UwCompletionObservation, { status: 'complete' }>
}
function nodeState(node: Extract<UwCompletionObservation, { status: 'complete' }>['graph']['nodes'][number]) {
  const scopes = (items: readonly { repository: string; target: string }[]) =>
    [...items].sort((a, b) => `${a.repository}\0${a.target}`.localeCompare(`${b.repository}\0${b.target}`))
  return {
    uw: node.uw,
    title: node.title,
    body: node.raw.body,
    labels: [...node.labels].sort(),
    parent: node.parent,
    children: scopes(node.children),
    blockers: scopes(node.blockers),
    native: node.native,
  }
}

function bindsActiveParent(input: CreatedChildAssessment, read: UwRead): boolean {
  const parent = input.creation.parentObservation
  return (
    parent !== null &&
    parent.state === 'active' &&
    read.uw.repository === parent.parent.repository &&
    read.uw.target === parent.parent.target &&
    input.core.target.repository === parent.parent.repository
  )
}

function graphUnchanged(before: CreatedChildAssessment['before'], current: CreatedChildAssessment['before']): boolean {
  for (const node of current.graph.nodes) {
    const prior = before.graph.nodes.find(
      (item) => item.uw.repository === node.uw.repository && item.uw.target === node.uw.target,
    )
    if (prior === undefined || canonicalValueDigest(nodeState(prior)) !== canonicalValueDigest(nodeState(node)))
      return false
  }
  return true
}

function observedWayfinders(
  scopes: { repository: string; target: string }[],
  attachedChildren: { scope: { repository: string; target: string } }[],
  before: CreatedChildAssessment['before'],
) {
  const wayfinders = []
  for (const scope of scopes.filter(
    (item) =>
      !attachedChildren.some(
        (child) => child.scope.repository === item.repository && child.scope.target === item.target,
      ),
  )) {
    const node = before.graph.nodes.find(
      (item) => item.uw.repository === scope.repository && item.uw.target === scope.target,
    )
    const observed = node === undefined ? null : nativeIssueObservationFromNode(node)
    if (observed === null)
      return actionFailure('action-input-missing', 'Attached wayfinder native observation is unavailable')
    wayfinders.push(observed)
  }
  return { ok: true as const, value: wayfinders }
}

function creationSourceAuthenticated(input: CreatedChildAssessment): boolean {
  const ref = input.creation.kind === 'sister' ? input.creation.disposition : input.creation.report
  const digest = input.creation.kind === 'sister' ? input.creation.dispositionDigest : input.creation.reportDigest
  const history = input.before.histories.find(
    (item) => item.source.scope.repository === ref.scope.repository && item.source.scope.target === ref.scope.target,
  )
  const source = history && bindExternalRef(ref, history)
  return !!source?.ok && specDigest(JSON.stringify(source.value)) === digest
}

function isMovedChild(
  child: { scope: { repository: string; target: string } },
  moved: CreatedChildAssessment['core']['writes']['relations']['addChildren'],
): boolean {
  return moved.some(
    (item) => child.scope.repository === item.repository && child.scope.target === `${item.repository}#${item.number}`,
  )
}

/** Project the sealed plan and explicit coverage from the authenticated before cut. */
export async function projectCreatedChildAssessment(
  input: CreatedChildAssessment,
  read: UwRead,
  assessmentReplay?: AssessmentReplayContext,
): Promise<
  Result<{ operands: Extract<ActionOperands, { action: 'assess-spec' }>; identitySources: RecordInputRef[] }>
> {
  if (!bindsActiveParent(input, read))
    return actionFailure('action-input-missing', 'The prepared creation does not bind the active parent')
  if (read.observation.status !== 'complete')
    return actionFailure('action-input-missing', 'Parent native observation is incomplete')
  if (!graphUnchanged(input.before, read.observation))
    return actionFailure('review-input-changed', 'Native graph changed before assessment')
  const sourceRefValue = input.creation.kind === 'sister' ? input.creation.disposition : input.creation.report
  if (!creationSourceAuthenticated(input))
    return actionFailure('action-input-missing', 'Creation source is not authenticated in the original observation')
  if (read.accepted.status !== 'accepted')
    return actionFailure('action-input-missing', 'Parent accepted Spec is absent')
  const current = await readCurrentOwnSpecFacts({ uw: read.uw, read, assessmentReplay })
  if (!current.ok) return { ok: false, diagnostics: toDiagnostics(current.diagnostics) }
  const accepted = read.accepted.value
  const baseline = {
    ref: accepted.ref,
    snapshot: accepted.snapshot,
    tier: accepted.tier,
    children: accepted.children,
    inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
    coverage: accepted.coverage,
  }
  const slot = { kind: 'created-by' as const, operationId: input.core.operationId }
  const proposed = {
    ...current.value.currentSpec,
    children: [
      ...current.value.currentSpec.children.filter(
        (child) => !isMovedChild(child, input.core.writes.relations.addChildren),
      ),
      { ...slot, plan: input.core, planDigest: canonicalValueDigest(input.core) },
    ],
    coverage: {
      ...input.parentCoverage,
      assignments: input.parentCoverage.assignments.map((row) => ({
        ...row,
        children: row.children.map((child) => ('kind' in child ? slot : child)) as [
          typeof slot | { repository: string; target: string },
          ...(typeof slot | { repository: string; target: string })[],
        ],
      })),
    },
  }
  const scopes = input.core.writes.relations.addChildren.map(({ repository, number }) => ({
    repository,
    target: `${repository}#${number}`,
  }))
  const attached = projectObservedChildCommitments({ scopes, observation: input.before })
  if (!attached.ok) return { ok: false, diagnostics: toDiagnostics(attached.diagnostics) }
  const attachedChildren = attached.value
  const attachedWayfinders = observedWayfinders(scopes, attachedChildren, input.before)
  if (!attachedWayfinders.ok) return attachedWayfinders
  const childOwnSources = capturedChildOwnSources(baseline, proposed, input.before.histories, attachedChildren)
  if (childOwnSources === null)
    return actionFailure('action-input-missing', 'Existing child authority cannot be authenticated')
  const candidate = actionOperandsSchema.safeParse({
    action: 'assess-spec',
    origin: { kind: 'cause-created-child', creation: input.creation },
    exactInputs: {
      format: 'omp-build-spec-assessment/3',
      accepted: baseline,
      proposed,
      attachedChildren,
      attachedWayfinders: attachedWayfinders.value,
      childOwnSources: childOwnSources.childOwnSources,
      identityAllocations: current.value.identityAllocations,
      mechanical: mechanicalSpecDelta(baseline, proposed),
    },
  })
  if (!candidate.success || candidate.data.action !== 'assess-spec')
    return actionFailure('action-input-missing', 'Created child proposal or explicit coverage is invalid')
  const identitySources: RecordInputRef[] = []
  const refs = [sourceRefValue, ...current.value.identityAllocations, ...childOwnSources.sourceRefs]
  for (const ref of refs) {
    const pinned = sourceRef(input.before.histories, ref)
    if (!pinned.ok) return pinned
    identitySources.push(pinned.value)
  }
  return { ok: true, value: { operands: candidate.data, identitySources } }
}
