import { assessUwAdmission } from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { publishFirstMandate } from './feature-mandate.ts'
import { prepareRequestedSession } from './feature-selection-session.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentOwnSpecFacts } from './uw-current-facts.ts'

export async function freshOwnSpec(
  scope: FeatureAuthority['scope'],
  read: UwRead | null,
  reader: UwReadPort | undefined,
): Promise<Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children'> | ContinueFeatureResult> {
  if (read === null || reader === undefined) return { kind: 'blocked', reason: 'uw-read-required' }
  if (!read.identity.ok)
    return { kind: 'blocked', reason: 'uw-identities-unconfirmed', diagnostics: read.identity.diagnostics }
  const initial = assessUwAdmission({
    uw: scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    phase: 'initial-selection',
  })
  if (!initial.deliverable.ok)
    return { kind: 'blocked', reason: 'uw-initial-admission-refused', diagnostics: initial.deliverable.diagnostics }
  const facts = await readCurrentOwnSpecFacts({ uw: scope, read, reader })
  if (!facts.ok) return { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
  const { currentSpec, identityAllocations } = facts.value
  return {
    ownSpec: {
      uw: scope,
      version: currentSpec.snapshot.spec.version,
      snapshot: currentSpec.snapshot,
      identityAllocations,
    },
    tier: currentSpec.tier,
    children: currentSpec.children,
  }
}

export async function establishFirstMandate(input: {
  authority: FeatureAuthority
  uwRead: UwRead | null
  reader: UwReadPort | undefined
  branch: string
  history: FeatureAuthority['history']
}): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'> | ContinueFeatureResult> {
  const { authority, uwRead, reader, branch, history } = input
  const { context, scope } = authority
  if (uwRead === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const own = await freshOwnSpec(scope, uwRead, reader)
  if ('kind' in own) return own
  const root = uwRead.graph.nodes.find(
    (node) => node.uw.repository === scope.repository && node.uw.target === scope.target,
  )
  if (root === undefined) return { kind: 'blocked', reason: 'graph-root-missing' }
  const parentAuthority = await firstMandateParent(authority, root.parent, own)
  if ('kind' in parentAuthority) return parentAuthority
  const { parent, parentHistories } = parentAuthority
  const prepared = await prepareRequestedSession(authority, branch)
  if (prepared !== null) return prepared
  const published = await publishFirstMandate(
    context.engine,
    history,
    scope,
    { ...own, parent },
    branch,
    context.git,
    context.gh,
    context.cwd,
    parentHistories,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  return confirmFirstMandateSelection(authority, parent)
}

async function firstMandateParent(
  authority: FeatureAuthority,
  parent: FeatureAuthority['scope'] | null,
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children'>,
): Promise<
  { parent: ExternalRecordRef | null; parentHistories: FeatureAuthority['parentHistories'] } | ContinueFeatureResult
> {
  if (parent === null) return { parent: null, parentHistories: authority.parentHistories }
  const { context, scope } = authority
  const read = await context.engine.readComposedWorkflowHistory([parent], { cwd: context.cwd, gh: context.gh })
  if (!read.ok) return { kind: 'blocked', reason: read.reason }
  const history = read.histories.find(
    (candidate) =>
      candidate.source.scope.repository === parent.repository && candidate.source.scope.target === parent.target,
  )
  if (history === undefined) return { kind: 'blocked', reason: 'parent-history-missing' }
  const ancestry = await mandateParentHistories(context.engine, history, { cwd: context.cwd, gh: context.gh })
  if (!ancestry.ok) return { kind: 'blocked', reason: ancestry.reason }
  const selected = context.engine.resolveOwnSpecAuthority(history, ancestry.parents)
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

async function confirmFirstMandateSelection(
  authority: FeatureAuthority,
  parent: ExternalRecordRef | null,
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'> | ContinueFeatureResult> {
  const { context, scope } = authority
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], { cwd: context.cwd, gh: context.gh })
  if (!refreshed.ok || refreshed.histories[0] === undefined)
    return { kind: 'blocked', reason: 'first-mandate-unconfirmed' }
  const history = refreshed.histories[0]
  const parents = await mandateParentHistories(context.engine, history, { cwd: context.cwd, gh: context.gh })
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const selected = context.engine.selectApplicableMandate(history, parents.parents)
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
  return { history, parentHistories: parents.parents, selection: selected }
}
