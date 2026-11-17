import { historicalAcceptedSpecPriorStarts, qualifyContextNegative } from '../dist/contracts.js'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { classifyAttempts, interruptionGate } from '../engine/workflow-action-interruption.ts'
import type { ContextDisposition } from '../engine/workflow-context-disposition-schema.ts'
import {
  contextHandoffAbsentBindingDigest,
  contextHandoffHistoryCut,
  contextHandoffHistoryDigest,
} from '../engine/workflow-context-handoff-history.ts'
import { workflowContextNegative } from '../engine/workflow-context-output.ts'
import { workflowContextTerminal } from '../engine/workflow-context-terminal.ts'
import { excludedReceipt, recordsOf, workflowOperationProblem } from '../engine/workflow-control.ts'
import { INTERRUPTION_ACTIONS } from '../engine/workflow-interruption-proof.ts'
import { contextHandoffDeliveryClear, observeContextHandoffCandidate } from './feature-context-handoff-candidate.ts'
import { canonicalContextWorktree } from './feature-context-handoff-worktree.ts'
import { observeParentSuccessorBaseline } from './feature-context-parent-successor.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { readSuccessionBasis } from './feature-succession.ts'
import { prepareSuccessorBinding } from './feature-succession-binding.ts'
import { successorOwnDelivery } from './feature-succession-observation.ts'
import { type ConfirmedContextAppend, projectConfirmedContextAppend } from './feature-succession-refresh.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead } from './uw-contract.ts'

export type { ContextHandoffCandidate } from './feature-context-handoff-candidate.ts'
export { contextHandoffDeliveryClear, observeContextHandoffCandidate } from './feature-context-handoff-candidate.ts'
export { observeCurrentContextSuccession } from './feature-context-successor-observation.ts'

export type ContextHandoffObservation = {
  reconciliation: ContextDisposition['reconciliation']
  negative: ContextDisposition['negative']
  replacementAccepted: ContextDisposition['replacementAccepted']
  histories: readonly FeatureAuthority['history'][]
}

export async function observeContextHandoff(input: {
  authority: FeatureAuthority
  uwRead: UwRead
  history: FeatureAuthority['history']
  parentHistories: readonly FeatureAuthority['history'][]
  negativeRecordId: string
  prospective?: ConfirmedContextAppend
}): Promise<{ ok: true; value: ContextHandoffObservation } | { ok: false; reason: string }> {
  const fail = () => ({ ok: false as const, reason: 'context-handoff-reconciliation-unconfirmed' })
  const { authority } = input
  const { scope, context } = authority
  const qualified = await prepareHandoff(input)
  if (qualified === null) return fail()
  const { histories, issue, causal, admission } = qualified
  const { basis, negative, payload } = admission
  const branch = basis.terminal.mandate.payload.branch
  const base = basis.terminal.mandate.payload.base
  const code = payload.inputs.manifest.code
  if (code.repository !== scope.repository || code.referenceCommit !== code.head) return fail()
  const remote = await observeHandoffRemote(authority, branch, base, code.head)
  if (remote === null) return fail()
  const { remoteBase, remoteBranch } = remote
  const delivery = await successorOwnDelivery(authority, histories, issue)
  if ('kind' in delivery || !contextHandoffDeliveryClear(delivery, scope)) return fail()
  const binding = await prepareSuccessorBinding(
    {
      loaded: context.engine,
      gh: context.gh,
      cwd: context.cwd,
      successorScope: scope,
      branch,
      base,
    },
    issue,
    basis.terminal.ref,
    delivery.pullRequests,
  )
  if (!binding.ok || binding.plan.kind !== 'absent') return fail()
  return {
    ok: true,
    value: {
      histories: causal.histories,
      negative,
      replacementAccepted: basis.historical.ref,
      reconciliation: {
        kind: 'unchanged-delivery-baseline',
        scope: 'workflow-owned-delivery-state',
        code,
        repository: scope.repository,
        branch,
        status: { code: 0, stdout: '' },
        remote: {
          base: { ref: `refs/heads/${base}`, tip: remoteBase },
          candidate: branch === null ? null : { ref: `refs/heads/${branch}`, tip: remoteBranch },
        },
        delivery: {
          uw: delivery.uw,
          pullRequests: [...delivery.pullRequests],
          integrations: [...delivery.integrations],
          commits: delivery.commits.map((commit) => ({ ...commit, parents: [...commit.parents] })),
        },
        cuts: contextHandoffHistoryCut(histories),
        historyDigest: contextHandoffHistoryDigest(histories),
        bindingDigest: contextHandoffAbsentBindingDigest(),
      },
    },
  }
}

async function prepareHandoff(input: Parameters<typeof observeContextHandoff>[0]) {
  const { authority, history, parentHistories, uwRead } = input
  const { scope, context } = authority
  if (
    authority.onPrincipal ||
    scope.repository !== history.source.scope.repository ||
    scope.target !== history.source.scope.target ||
    workflowOperationProblem(history) !== null
  )
    return null
  const options = withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh })
  const observed = await composeObservedUwCausalContext(uwRead, [history, ...parentHistories], options)
  if (!observed.ok) return null
  const causal = observed.value
  const histories =
    input.prospective === undefined
      ? causal.histories
      : projectConfirmedContextAppend(causal.histories, input.prospective)
  if (histories === null || histories.some((item) => workflowOperationProblem(item) !== null)) return null
  const issue = histories.find(
    (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
  )
  if (issue === undefined) return null
  const admission = qualifyHandoff(issue, histories, scope, input.negativeRecordId)
  return admission === null ? null : { histories, issue, causal, admission }
}

async function observeHandoffRemote(
  authority: FeatureAuthority,
  branch: string | null,
  base: string,
  head: string,
): Promise<{ remoteBase: string; remoteBranch: string | null } | null> {
  if (branch === null) {
    if (!(await observeParentSuccessorBaseline({ authority, base, head }))) return null
    return { remoteBase: head, remoteBranch: null }
  }
  if (!(await canonicalContextWorktree(authority, branch))) return null
  const { context, scope } = authority
  const candidate = await observeContextHandoffCandidate({
    git: context.git,
    gh: context.gh,
    cwd: context.cwd,
    repository: scope.repository,
    branch,
    base,
    baseline: head,
  })
  return candidate.ok ? candidate.value : null
}

function qualifyHandoff(
  issue: FeatureAuthority['history'],
  histories: readonly FeatureAuthority['history'][],
  scope: FeatureAuthority['scope'],
  negativeRecordId: string,
) {
  const basis = readSuccessionBasis(issue, histories, true)
  if (!basis.ok) return null
  const selected = recordsOf(issue).filter(
    (record) => record.kind === 'action-receipt' && record.recordId === negativeRecordId,
  )
  const record = selected[0]
  if (selected.length !== 1 || record?.kind !== 'action-receipt') return null
  const negative: ContextDisposition['negative'] = {
    source: 'record',
    record: { scope, kind: 'action-receipt', recordId: record.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
  const authenticated = qualifyContextNegative({ mandate: basis.value.terminal.mandate, histories, negative })
  if (!authenticated.ok) return null
  const priorStarts = historicalAcceptedSpecPriorStarts(
    authenticated.value.historical,
    authenticated.value.histories,
    basis.value.terminal.mandate,
  )
  if (!priorStarts.ok) return null
  const payload = authenticated.value.negativeLeaf.payload
  if (
    (payload.action !== 'implement' &&
      payload.action !== 'plan' &&
      payload.action !== 'plan-review' &&
      payload.action !== 'assess-spec') ||
    payload.phase !== 'result' ||
    payload.mandate.kind !== 'mandate' ||
    payload.mandate.recordId !== basis.value.terminal.ref.recordId ||
    payload.mandate.scope.repository !== scope.repository ||
    payload.mandate.scope.target !== scope.target
  )
    return null
  const attempts = classifyAttempts({ histories, scan: [issue], actions: INTERRUPTION_ACTIONS })
  if (interruptionGate(attempts).kind !== 'clear') return null
  if (!handoffReceiptsClear(issue, payload.action, priorStarts.value, authenticated.value.negativeChain)) return null
  return { basis: basis.value, negative, payload }
}

function handoffReceiptsClear(
  issue: FeatureAuthority['history'],
  selectedAction: string,
  priorStarts: ReadonlySet<string>,
  negativeChain: readonly { recordId: string }[],
): boolean {
  const receipts = recordsOf(issue).filter((item) => item.kind === 'action-receipt')
  for (const item of receipts) {
    if (item.payload.phase !== 'result') continue
    if (excludedReceipt(item, priorStarts)) continue
    if (!isHandoffDeliveryReceipt(item, selectedAction)) continue
    if (item.payload.action !== selectedAction || !workflowContextNegative(item)) return false
    if (!negativeChain.some((member) => member.recordId === item.recordId)) return false
  }
  return otherHandoffActionsClear(issue, selectedAction, priorStarts)
}

function isHandoffDeliveryReceipt(
  receipt: Extract<ReturnType<typeof recordsOf>[number], { kind: 'action-receipt' }>,
  selectedAction: string,
): boolean {
  return (
    receipt.payload.action === 'implement' ||
    receipt.payload.action === 'integrate' ||
    (receipt.payload.action === selectedAction && workflowContextNegative(receipt))
  )
}

function otherHandoffActionsClear(
  issue: FeatureAuthority['history'],
  selectedAction: string,
  priorStarts: ReadonlySet<string>,
): boolean {
  for (const action of ['plan', 'plan-review', 'implement', 'integrate', 'assess-spec', 'attribute-ci'])
    if (action !== selectedAction && workflowContextTerminal(issue, action, undefined, priorStarts) !== 'clear')
      return false
  return true
}
