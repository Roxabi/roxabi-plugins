import { canonicalValueDigest, projectNativeUwChildren } from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import { causalRefusal } from './causal-refusal.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { observeInitialCheckout } from './feature-initial-checkout.ts'
import { freshOwnSpec, type LeafOwnSpec } from './feature-initial-own-spec.ts'
import { firstMandateParent, prepareInitialParentSession } from './feature-initial-parent.ts'
import { initialCheckoutTarget } from './feature-initial-target.ts'
import { publishFirstMandate } from './feature-mandate.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareRequestedSession } from './feature-selection-session.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { type FeatureCheckoutTarget, runWorktreeBootstrap } from './workflow-checkout.ts'

export async function establishFirstMandate(input: {
  authority: FeatureAuthority
  uwRead: UwRead | null
  reader: UwReadPort | undefined
  branch: string
  history: FeatureAuthority['history']
}): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'> | ContinueFeatureResult> {
  const { authority, uwRead, reader, branch, history } = input
  const { scope } = authority
  if (uwRead === null || reader === undefined) return { kind: 'blocked', reason: 'uw-read-required' }
  const children = projectNativeUwChildren({ uw: scope, graph: uwRead.graph, accepted: uwRead.accepted })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  if (children.value.length > 0) return { kind: 'blocked', reason: 'parent-delivery-suspended' }
  const anchor = await resolveParentWorktreeAnchor({ subject: scope, read: uwRead })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  const root = uwRead.graph.nodes.find(
    (node) => node.uw.repository === scope.repository && node.uw.target === scope.target,
  )
  if (root === undefined) return { kind: 'blocked', reason: 'graph-root-missing' }
  const own = await freshOwnSpec(scope, uwRead, reader)
  if ('kind' in own) return own
  const parentAuthority = await firstMandateParent(authority, root.parent, own, uwRead)
  if ('kind' in parentAuthority) return parentAuthority
  const parentSession = await prepareInitialParentSession(authority, root.parent, anchor.anchor)
  if (parentSession !== null) return parentSession
  const target = await initialCheckoutTarget(authority, root.parent === null ? null : anchor.anchor, branch)
  if (target.kind !== 'branch') return target
  return prepareAndPublishInitial({
    authority,
    reader,
    rootParent: root.parent,
    parentAuthority,
    own,
    target,
    history,
    anchor: anchor.anchor,
  })
}

async function prepareAndPublishInitial(input: {
  authority: FeatureAuthority
  reader: UwReadPort
  rootParent: FeatureAuthority['scope'] | null
  parentAuthority: { parent: ExternalRecordRef | null; parentHistories: FeatureAuthority['parentHistories'] }
  own: LeafOwnSpec
  anchor: FeatureAuthority['scope']
  target: Extract<FeatureCheckoutTarget, { kind: 'branch' }>
  history: FeatureAuthority['history']
}): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'> | ContinueFeatureResult> {
  const { authority, reader, rootParent, parentAuthority, own, target, history } = input
  const { context, scope } = authority
  const { parent } = parentAuthority
  const prepared = await prepareRequestedSession(authority, target)
  if ('kind' in prepared) return prepared
  const before = await observeInitialCheckout(authority, target, prepared.base)
  if ('kind' in before) return before
  const boot = await runWorktreeBootstrap(context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  const currentParent = await confirmFirstMandateFraming(authority, reader, rootParent, parent, own, history)
  if ('kind' in currentParent) return currentParent
  if (canonicalValueDigest(currentParent.parentHistories) !== canonicalValueDigest(parentAuthority.parentHistories))
    return { kind: 'blocked', reason: 'first-mandate-parent-changed' }
  const latest = await reader.readUw(scope)
  const anchor = await resolveParentWorktreeAnchor({ subject: scope, read: latest })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (canonicalValueDigest(anchor.anchor) !== canonicalValueDigest(input.anchor))
    return { kind: 'blocked', reason: 'first-mandate-framing-changed' }
  const checkout = await observeInitialCheckout(authority, target, prepared.base)
  if ('kind' in checkout) return checkout
  if (
    checkout.principalHead !== before.principalHead ||
    canonicalValueDigest(checkout.checkout) !== canonicalValueDigest(before.checkout)
  )
    return { kind: 'blocked', reason: 'first-mandate-checkout-changed' }
  const published = await publishFirstMandate(
    context.engine,
    history,
    scope,
    { ...own, parent },
    checkout.checkout,
    context.git,
    context.gh,
    context.cwd,
    currentParent.parentHistories,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  return confirmFirstMandateSelection(authority, parent, reader)
}

async function confirmFirstMandateFraming(
  authority: FeatureAuthority,
  reader: UwReadPort,
  rootParent: FeatureAuthority['scope'] | null,
  parent: ExternalRecordRef | null,
  own: LeafOwnSpec,
  history: FeatureAuthority['history'],
): Promise<
  { parent: ExternalRecordRef | null; parentHistories: FeatureAuthority['parentHistories'] } | ContinueFeatureResult
> {
  const { scope } = authority
  const latest = await reader.readUw(scope)
  const children = projectNativeUwChildren({ uw: scope, graph: latest.graph, accepted: latest.accepted })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  if (children.value.length > 0) return { kind: 'blocked', reason: 'first-mandate-framing-changed' }
  const { context } = authority
  const historyRead = await context.engine.readComposedWorkflowHistory([scope], {
    ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }),
    gh: context.gh,
  })
  if (
    !historyRead.ok ||
    historyRead.histories[0] === undefined ||
    canonicalValueDigest(historyRead.histories[0]) !== canonicalValueDigest(history)
  )
    return { kind: 'blocked', reason: 'first-mandate-history-changed' }
  const current = await freshOwnSpec(scope, latest, reader)
  if ('kind' in current) return current
  const latestRoot = latest.graph.nodes.find(
    (node) => node.uw.repository === scope.repository && node.uw.target === scope.target,
  )
  if (
    latestRoot === undefined ||
    canonicalValueDigest(latestRoot.parent) !== canonicalValueDigest(rootParent) ||
    canonicalValueDigest(current) !== canonicalValueDigest(own)
  )
    return { kind: 'blocked', reason: 'first-mandate-framing-changed' }
  const currentParent = await firstMandateParent(authority, latestRoot.parent, current, latest)
  if ('kind' in currentParent) return currentParent
  if (canonicalValueDigest(currentParent.parent) !== canonicalValueDigest(parent))
    return { kind: 'blocked', reason: 'first-mandate-parent-changed' }
  return currentParent
}

async function confirmFirstMandateSelection(
  authority: FeatureAuthority,
  parent: ExternalRecordRef | null,
  reader: UwReadPort,
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'> | ContinueFeatureResult> {
  const { context, scope } = authority
  const options = { ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }), gh: context.gh }
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], options)
  if (!refreshed.ok || refreshed.histories[0] === undefined)
    return { kind: 'blocked', reason: 'first-mandate-unconfirmed' }
  const history = refreshed.histories[0]
  const parents = await mandateParentHistories(context.engine, history, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const read = await reader.readUw(scope)
  const causal = await composeObservedUwCausalContext(read, [history, ...parents.parents], options)
  if (!causal.ok) return { kind: 'blocked', ...causalRefusal(causal) }
  const selected = context.engine.selectApplicableMandate(history, parents.parents, causal.value)
  if (selected.status !== 'applicable' || selected.mandate === null)
    return { kind: 'blocked', reason: 'first-mandate-unconfirmed' }
  if (
    parent !== null &&
    (selected.mandate.payload.parent === null ||
      selected.mandate.payload.parent.recordId !== parent.recordId ||
      selected.mandate.payload.parent.scope.repository !== parent.scope.repository ||
      selected.mandate.payload.parent.scope.target !== parent.scope.target)
  )
    return { kind: 'blocked', reason: 'first-mandate-parent-unconfirmed' }
  return { history, parentHistories: parents.parents, causal: causal.value, selection: selected }
}
