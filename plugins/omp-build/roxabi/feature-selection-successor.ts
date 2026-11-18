import { canonicalValueDigest, projectNativeUwChildrenAgainstCommitments } from '../dist/contracts.js'
import type { NativeDeliveryPullRequest } from '../engine/uw-completion-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import { causalRefusal } from './causal-refusal.ts'
import { checkoutTarget } from './feature-checkout-target.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContextHandoffRequest, ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { freshSuccessorOwnSpec } from './feature-initial-own-spec.ts'
import { resolveSuccessorWorktreeAnchor } from './feature-parent-anchor.ts'
import { createHandoffObserver } from './feature-selection-handoff.ts'
import {
  bootstrapSuccessor,
  confirmSuccessorCheckout,
  ensureSuccessorParent,
  prepareSuccessorCoverageRequest,
} from './feature-selection-successor-checkout.ts'
import { type ContextHandoffPublication, publishSuccessorMandate, type SuccessionBasis } from './feature-succession.ts'
import {
  type ConfirmedSuccessor,
  confirmSuccessorHistories,
  currentSuccessionBasis,
  successorOwnDelivery,
} from './feature-succession-observation.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function createSuccessorSelection(input: {
  authority: FeatureAuthority
  uwRead: UwRead | null
  reader: UwReadPort | undefined
  uw?: UwOperations
  branch: string
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
  parentCoverage?: ParentCoverage | null
  parentCoverageBasis?: ParentCoverageRequest
  contextHandoff?: ContextHandoffRequest
}): Promise<SelectionState | ContinueFeatureResult> {
  if (input.contextHandoff !== undefined && input.uw === undefined)
    return { kind: 'blocked', reason: 'context-handoff-operator-unavailable' }
  const { authority, uwRead, reader, history, parentHistories } = input
  if (reader === undefined || uwRead === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const prepared = await prepareSuccessorSelection(input, uwRead)
  if ('kind' in prepared) return prepared
  const { basis, delivery, own, target, anchor } = prepared
  const observeHandoff =
    input.contextHandoff === undefined
      ? undefined
      : createHandoffObserver(authority, reader, history, input.contextHandoff)
  try {
    const initialHandoff = observeHandoff === undefined ? undefined : await observeHandoff()
    if (initialHandoff?.ok === false) return { kind: 'blocked', reason: initialHandoff.reason }
    const boot = await bootstrapSuccessor(authority, target)
    if ('kind' in boot) return boot
    const confirmed = await confirmSuccessorAfterBootstrap({
      pullRequests: delivery.pullRequests,
      authority,
      reader,
      own,
      basis,
      history,
      parentHistories,
      target,
      anchor,
      head: boot.head,
      branch: boot.branch,
      parentCoverage: input.parentCoverage,
      parentCoverageBasis: input.parentCoverageBasis,
      contextHandoff: input.contextHandoff !== undefined,
    })
    if ('kind' in confirmed) return confirmed
    const afterBootstrap = observeHandoff === undefined ? undefined : await observeHandoff()
    if (afterBootstrap?.ok === false) return { kind: 'blocked', reason: afterBootstrap.reason }
    if (handoffObservationChanged(initialHandoff, afterBootstrap))
      return { kind: 'blocked', reason: 'context-handoff-observation-changed' }
    return await publishAndRefreshSuccessor(
      authority,
      own,
      confirmed.basis,
      target,
      confirmed.history,
      confirmed.parents,
      reader,
      confirmed.delivery.pullRequests,
      handoffPublication(initialHandoff, input.uw, observeHandoff),
    )
  } finally {
    await observeHandoff?.dispose()
  }
}

function handoffPublication(
  initial: Awaited<ReturnType<ReturnType<typeof createHandoffObserver>>> | undefined,
  operations: UwOperations | undefined,
  observe: ReturnType<typeof createHandoffObserver> | undefined,
): ContextHandoffPublication | undefined {
  return initial?.ok && operations !== undefined && observe !== undefined
    ? { operations, observed: initial.value, observe, canPublish: () => observe.canPublish() }
    : undefined
}

function handoffObservationChanged(
  initial: Awaited<ReturnType<ReturnType<typeof createHandoffObserver>>> | undefined,
  current: Awaited<ReturnType<ReturnType<typeof createHandoffObserver>>> | undefined,
): boolean {
  return (
    initial?.ok === true &&
    current?.ok === true &&
    canonicalValueDigest(initial.value.reconciliation) !== canonicalValueDigest(current.value.reconciliation)
  )
}

async function prepareSuccessorSelection(input: Parameters<typeof createSuccessorSelection>[0], uwRead: UwRead) {
  const { authority, history, parentHistories } = input
  const observedBasis = await currentSuccessionBasis(
    authority,
    uwRead,
    history,
    parentHistories,
    input.contextHandoff !== undefined,
  )
  if ('kind' in observedBasis) return observedBasis
  const basis = observedBasis.basis
  const delivery = await successorOwnDelivery(authority, observedBasis.histories, history)
  if ('kind' in delivery) return delivery
  const children = projectNativeUwChildrenAgainstCommitments({
    uw: authority.scope,
    graph: uwRead.graph,
    commitments: basis.historical.children,
  })
  const projected = checkoutTarget({
    uw: authority.scope,
    children,
    branch: basis.terminal.mandate.payload.branch ?? input.branch,
  })
  if ('kind' in projected) return projected
  const own = await freshSuccessorOwnSpec(
    authority.scope,
    uwRead,
    basis.historical,
    input.parentCoverage,
    input.parentCoverageBasis,
    input.contextHandoff !== undefined,
  )
  if ('kind' in own) return prepareSuccessorCoverageRequest(authority, uwRead, basis, projected.target, own)
  const anchor = await resolveSuccessorWorktreeAnchor({
    subject: authority.scope,
    read: uwRead,
    succession: { child: authority.scope, tip: basis.terminal.ref },
  })
  if (!anchor.ok) return { kind: 'blocked' as const, reason: anchor.reason }
  if (projected.target.kind === 'parent') projected.target.uw = anchor.anchor
  const parentCheck = await ensureSuccessorParent(authority, uwRead, projected.target, anchor.anchor)
  if (parentCheck !== null) return parentCheck
  if (!successorPullBranchMatches(authority, projected.target))
    return { kind: 'blocked' as const, reason: 'successor-branch-mismatch' }
  const target: FeatureCheckoutTarget =
    projected.target.kind === 'branch' && authority.target.status === 'pull-request'
      ? { ...projected.target, attachExisting: true }
      : projected.target
  return { basis, delivery, own, target, anchor: anchor.anchor }
}

function successorPullBranchMatches(authority: FeatureAuthority, target: FeatureCheckoutTarget): boolean {
  if (target.kind !== 'branch' || authority.target.status !== 'pull-request') return true
  return target.branch === authority.target.pullRequest.branch
}

async function confirmSuccessorAfterBootstrap(input: {
  authority: FeatureAuthority
  reader: UwReadPort
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>
  basis: SuccessionBasis
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
  target: FeatureCheckoutTarget
  anchor: FeatureAuthority['scope']
  head: string
  branch: string
  pullRequests: readonly NativeDeliveryPullRequest[]
  parentCoverage?: ParentCoverage | null
  parentCoverageBasis?: ParentCoverageRequest
  contextHandoff: boolean
}): Promise<ConfirmedSuccessor | ContinueFeatureResult> {
  const { authority, reader, own, history, parentHistories } = input
  const latest = await reader.readUw(authority.scope)
  const observedBasis = await currentSuccessionBasis(authority, latest, history, parentHistories, input.contextHandoff)
  if ('kind' in observedBasis) return observedBasis
  const currentBasis = observedBasis.basis
  if (canonicalValueDigest(currentBasis) !== canonicalValueDigest(input.basis))
    return { kind: 'blocked', reason: 'successor-antecedent-changed' }
  const children = projectNativeUwChildrenAgainstCommitments({
    uw: authority.scope,
    graph: latest.graph,
    commitments: currentBasis.historical.children,
  })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  if (children.value.length > 0 !== (input.target.kind === 'parent'))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const current = await freshSuccessorOwnSpec(
    authority.scope,
    latest,
    currentBasis.historical,
    input.parentCoverage,
    input.parentCoverageBasis,
    input.contextHandoff,
  )
  if ('kind' in current) return current
  if (canonicalValueDigest(current) !== canonicalValueDigest(own))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const anchor = await resolveSuccessorWorktreeAnchor({
    subject: authority.scope,
    read: latest,
    succession: { child: authority.scope, tip: currentBasis.terminal.ref },
  })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (canonicalValueDigest(anchor.anchor) !== canonicalValueDigest(input.anchor))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const checkout = await confirmSuccessorCheckout(authority, input.target, input.head, input.branch)
  if (checkout !== null) return checkout
  const confirmed = await confirmSuccessorHistories(authority, latest, history, parentHistories, currentBasis)
  if ('kind' in confirmed) return confirmed
  if (canonicalValueDigest(input.pullRequests) !== canonicalValueDigest(confirmed.delivery.pullRequests))
    return { kind: 'blocked', reason: 'successor-binding-observation-changed' }
  return confirmed
}

async function publishAndRefreshSuccessor(
  authority: FeatureAuthority,
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>,
  basis: SuccessionBasis,
  target: FeatureCheckoutTarget,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
  reader: UwReadPort,
  observedPullRequests: readonly NativeDeliveryPullRequest[],
  contextHandoff?: ContextHandoffPublication,
): Promise<SelectionState | ContinueFeatureResult> {
  const { context, scope } = authority
  const succession = await publishSuccessorMandate({
    loaded: context.engine,
    history,
    scope,
    basis,
    ...own,
    target,
    git: context.git,
    gh: context.gh,
    cwd: context.cwd,
    parents: parentHistories,
    observedPullRequests,
    ...(contextHandoff === undefined ? {} : { contextHandoff }),
  })
  if (!succession.ok) return { kind: 'blocked', reason: succession.reason }
  const options = { ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }), gh: context.gh }
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], options)
  if (!refreshed.ok || refreshed.histories[0] === undefined) return { kind: 'blocked', reason: 'successor-unconfirmed' }
  const nextHistory = refreshed.histories[0]
  const parents = await mandateParentHistories(context.engine, nextHistory, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const read = await reader.readUw(scope)
  const causal = await composeObservedUwCausalContext(read, [nextHistory, ...parents.parents], options)
  if (!causal.ok) return { kind: 'blocked', ...causalRefusal(causal) }
  const selection = context.engine.selectApplicableMandate(nextHistory, parents.parents, causal.value)
  if (selection.status !== 'applicable') {
    return { kind: 'blocked', reason: `successor-${selection.status === 'refused' ? selection.reason : 'unconfirmed'}` }
  }
  return { history: nextHistory, parentHistories: parents.parents, causal: causal.value, selection }
}
