import { canonicalValueDigest, contextHandoffAbsentBindingDigest, selectWorkflowBinding } from '../dist/contracts.js'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { ContextSuccessionObservation } from '../engine/workflow-reconstruction-types.ts'
import { contextHandoffDeliveryClear, observeContextHandoffCandidate } from './feature-context-handoff-candidate.ts'
import { canonicalContextWorktree, canonicalPredecessorWorktree } from './feature-context-handoff-worktree.ts'
import { observeParentSuccessorBaseline, observeParentSuccessorEffect } from './feature-context-parent-successor.ts'
import { findSuccessionAdmission } from './feature-context-successor-admission.ts'
import { admittedImplementationReceipt, successorReceiptResults } from './feature-context-successor-receipts.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { prepareSuccessorBinding } from './feature-succession-binding.ts'
import { successorOwnDelivery } from './feature-succession-observation.ts'
/** Reobserve the managed baseline before using a persisted successor disposition. */
export async function observeCurrentContextSuccession(input: {
  authority: FeatureAuthority
  mandate: MandateRecord
  causal: WorkflowCausalContext
}): Promise<{ ok: true; value: ContextSuccessionObservation | null } | { ok: false; reason: string }> {
  const fail = () => ({ ok: false as const, reason: 'context-succession-observation-unconfirmed' })
  const { authority, mandate, causal } = input
  const { scope, context } = authority
  const mandateRef = { scope, recordId: mandate.recordId, kind: 'mandate' as const }
  const admission = findSuccessionAdmission(input, mandateRef)
  if (admission.kind === 'absent') return { ok: true, value: null }
  if (admission.kind === 'refused') return fail()
  const { issue, control, admitted, historical, historyDigest } = admission
  const branch = admitted.value.predecessor.payload.branch
  const base = admitted.value.predecessor.payload.base
  const code = admitted.value.baselineCode
  const successorResults = successorReceiptResults(issue, mandate, mandateRef)
  if (mandate.payload.branch === null && successorResults.length > 0) return observeParentEffect()
  const worktree = await prepareWorktree()
  if ('result' in worktree) return worktree.result
  const candidateCwd = worktree.cwd
  if (successorResults.length > 0) return observeAdmittedDelivery()
  const candidate =
    branch === null
      ? null
      : await observeContextHandoffCandidate({
          git: context.git,
          gh: context.gh,
          cwd: candidateCwd,
          repository: scope.repository,
          branch,
          base,
          baseline: code.head,
        })
  if (candidate !== null && !candidate.ok) return fail()
  const delivery = await successorOwnDelivery(authority, causal.histories, issue)
  if ('kind' in delivery || !contextHandoffDeliveryClear(delivery, scope)) return fail()
  const predecessor = { scope, recordId: admitted.value.predecessor.recordId, kind: 'mandate' as const }
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
    predecessor,
    delivery.pullRequests,
  )
  if (!binding.ok || binding.plan.kind !== 'absent') return fail()
  return {
    ok: true,
    value: {
      control: { scope, kind: 'operator-control', recordId: control.recordId },
      reconciliation: {
        kind: 'unchanged-delivery-baseline',
        scope: 'workflow-owned-delivery-state',
        code,
        repository: scope.repository,
        branch,
        status: { code: 0, stdout: '' },
        remote: successorBaselineRemote(base, branch, code.head, candidate),
        delivery: {
          uw: delivery.uw,
          pullRequests: [...delivery.pullRequests],
          integrations: [...delivery.integrations],
          commits: delivery.commits.map((commit) => ({ ...commit, parents: [...commit.parents] })),
        },
        cuts: historical.cuts,
        historyDigest,
        bindingDigest: contextHandoffAbsentBindingDigest(),
      },
    },
  }

  function observeParentEffect() {
    const result = successorResults[0]
    if (successorResults.length !== 1 || result?.kind !== 'action-receipt') return fail()
    return observeParentSuccessorEffect({ authority, mandate, causal, control, result })
  }

  async function prepareWorktree(): Promise<
    { cwd: string } | { result: { ok: true; value: ContextSuccessionObservation } | { ok: false; reason: string } }
  > {
    if (branch === null) return prepareParentWorktree()
    if (mandate.payload.branch === null) {
      if (!(await observeParentSuccessorBaseline({ authority, base, head: code.head }))) return { result: fail() }
      const predecessorCwd = await canonicalPredecessorWorktree(authority, branch)
      return predecessorCwd === null ? { result: fail() } : { cwd: predecessorCwd }
    }
    return (await canonicalContextWorktree(authority, branch)) ? { cwd: context.cwd } : { result: fail() }
  }

  async function prepareParentWorktree(): ReturnType<typeof prepareWorktree> {
    if (mandate.payload.branch !== null) return { result: fail() }
    const head = await context.git(context.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const tip = head.stdout.trim()
    if (head.code !== 0 || !(await observeParentSuccessorBaseline({ authority, base, head: tip })))
      return { result: fail() }
    if (tip === code.head) return { cwd: context.cwd }
    const delivery = await successorOwnDelivery(authority, causal.histories, issue)
    if ('kind' in delivery || !contextHandoffDeliveryClear(delivery, scope)) return { result: fail() }
    return {
      result: {
        ok: true,
        value: {
          kind: 'parent-child-advance',
          control: { scope, kind: 'operator-control', recordId: control.recordId },
          candidate: { kind: 'parent', repository: scope.repository, head: tip, clean: true, remoteBase: tip },
          delivery,
        },
      },
    }
  }

  async function observeAdmittedDelivery(): Promise<
    { ok: true; value: ContextSuccessionObservation } | { ok: false; reason: string }
  > {
    if (successorResults.length !== 1 || branch === null) return fail()
    const receipt = admittedImplementationReceipt(issue, successorResults[0])
    if (receipt === null) return fail()
    const { result, tip } = receipt
    const observed = await observeContextHandoffCandidate({
      git: context.git,
      gh: context.gh,
      cwd: context.cwd,
      repository: scope.repository,
      branch,
      base,
      baseline: tip,
    })
    if (!observed.ok || observed.value.remoteBranch !== tip) return fail()
    const delivery = await successorOwnDelivery(authority, causal.histories, issue)
    if (
      'kind' in delivery ||
      delivery.uw.repository !== scope.repository ||
      delivery.uw.target !== scope.target ||
      delivery.integrations.length !== 0 ||
      delivery.pullRequests.length > 1
    )
      return fail()
    const binding = await resolveBinding()
    if (binding === null) return fail()
    return {
      ok: true,
      value: {
        kind: 'admitted-successor-delivery',
        control: { scope, kind: 'operator-control', recordId: control.recordId },
        receipt: {
          source: 'record',
          record: { scope, kind: 'action-receipt', recordId: result.recordId },
          selector: '/payload',
          digest: canonicalValueDigest(result.payload),
        },
        candidate: {
          repository: observed.value.repository,
          branch: observed.value.branch,
          head: observed.value.head,
          clean: true,
          remoteBranch: observed.value.remoteBranch,
          remoteBase: observed.value.remoteBase,
        },
        delivery,
        binding,
      },
    }

    async function resolveBinding(): Promise<
      Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>['binding'] | null
    > {
      if (branch === null || 'kind' in delivery) return null
      const pull = delivery.pullRequests[0]
      if (pull === undefined) return resolveAbsentBinding(branch)
      if (pull.branch !== branch || pull.base !== base || pull.head !== tip) return null
      const selected = selectWorkflowBinding({
        pullRequest: pull.pullRequest,
        histories: causal.histories,
        native: { branch: pull.branch, base: pull.base },
      })
      if (selected.status !== 'bound' || !sameRef(selected.mandate, mandateRef)) return null
      return {
        kind: 'pull-request',
        scope: pull.pullRequest,
        record: { scope: pull.pullRequest, kind: 'workflow-binding', recordId: selected.binding.recordId },
      }
    }

    async function resolveAbsentBinding(
      branch: string,
    ): Promise<Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>['binding'] | null> {
      const absent = await prepareSuccessorBinding(
        { loaded: context.engine, gh: context.gh, cwd: context.cwd, successorScope: scope, branch, base },
        issue,
        mandateRef,
        [],
      )
      return absent.ok && absent.plan.kind === 'absent' ? { kind: 'absent' } : null
    }
  }
}

function successorBaselineRemote(
  base: string,
  branch: string | null,
  head: string,
  candidate: Extract<Awaited<ReturnType<typeof observeContextHandoffCandidate>>, { ok: true }> | null,
) {
  return {
    base: { ref: `refs/heads/${base}`, tip: candidate === null ? head : candidate.value.remoteBase },
    candidate: candidate === null ? null : { ref: `refs/heads/${branch}`, tip: candidate.value.remoteBranch },
  }
}
