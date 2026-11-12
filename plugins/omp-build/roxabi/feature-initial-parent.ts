import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { causalRefusal } from './causal-refusal.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { prepareRequestedSession } from './feature-selection-session.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead } from './uw-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'

export async function prepareInitialParentSession(
  authority: FeatureAuthority,
  rootParent: FeatureAuthority['scope'] | null,
  target: FeatureCheckoutTarget,
  anchor: FeatureAuthority['scope'],
): Promise<ContinueFeatureResult | null> {
  if (rootParent !== null && target.kind === 'branch' && authority.onPrincipal) {
    const prepared = await prepareRequestedSession(authority, { kind: 'parent', uw: anchor })
    if ('kind' in prepared) return prepared
    return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  }
  return null
}
export async function firstMandateParent(
  authority: FeatureAuthority,
  parent: FeatureAuthority['scope'] | null,
  own: { tier: MandateRecord['payload']['tier']; ownSpec: { version: string } },
  uwRead: UwRead,
): Promise<
  { parent: ExternalRecordRef | null; parentHistories: FeatureAuthority['parentHistories'] } | ContinueFeatureResult
> {
  if (parent === null) return { parent: null, parentHistories: authority.parentHistories }
  const { context, scope } = authority
  const options = { ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }), gh: context.gh }
  const read = await context.engine.readComposedWorkflowHistory([parent], options)
  if (!read.ok) return { kind: 'blocked', reason: read.reason }
  const history = read.histories.find(
    (candidate) =>
      candidate.source.scope.repository === parent.repository && candidate.source.scope.target === parent.target,
  )
  if (history === undefined) return { kind: 'blocked', reason: 'parent-history-missing' }
  const ancestry = await mandateParentHistories(context.engine, history, options)
  if (!ancestry.ok) return { kind: 'blocked', reason: ancestry.reason }
  const causal = await composeObservedUwCausalContext(uwRead, [history, ...ancestry.parents], options)
  if (!causal.ok) return { kind: 'blocked', ...causalRefusal(causal) }
  const selected = context.engine.resolveOwnSpecAuthority(history, ancestry.parents, causal.value)
  if (!selected.ok) return { kind: 'blocked', reason: 'parent-mandate-unconfirmed', diagnostics: selected.diagnostics }
  const commitment = selected.value.accepted.children.find(
    (child) => child.scope.repository === scope.repository && child.scope.target === scope.target,
  )
  if (commitment === undefined || commitment.tier !== own.tier || commitment.specVersion !== own.ownSpec.version)
    return { kind: 'blocked', reason: 'parent-child-commitment-mismatch' }
  const { permissions } = selected.value.mandate.payload
  if (!permissions.landing || !permissions.correct) return { kind: 'blocked', reason: 'parent-permission-excess' }
  return {
    parent: { scope: parent, recordId: selected.value.mandate.recordId, kind: 'mandate' },
    parentHistories: [history, ...ancestry.parents],
  }
}
