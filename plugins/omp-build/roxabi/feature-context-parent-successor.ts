import { authenticateWorkflowReceiptPair, canonicalValueDigest, integrationReceiptEligible } from '../dist/contracts.js'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { ContextSuccessionObservation } from '../engine/workflow-reconstruction-types.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { successorOwnDelivery } from './feature-succession-observation.ts'
import { currentParentIntegration } from './uw-parent-current-integration.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import { verifyParentCheckout } from './workflow-checkout.ts'

/** Observe the detached parent independently of the predecessor's branch checkout. */
export async function observeParentSuccessorBaseline(input: {
  authority: FeatureAuthority
  base: string
  head: string
}): Promise<boolean> {
  try {
    const { authority, base, head: tip } = input
    const { context, scope } = authority
    if (!/^[0-9a-f]{40}$/.test(tip)) return false
    const read = await createInstalledUwReadPort({ cwd: context.cwd, gh: context.gh }).readUw(scope)
    const anchor = await resolveParentWorktreeAnchor({ subject: scope, read })
    if (!anchor.ok || !(await verifyParentCheckout({ git: context.git, cwd: context.cwd, uw: anchor.anchor })).ok)
      return false
    const origin = await context.git(context.cwd, ['remote', 'get-url', 'origin'])
    if (origin.code !== 0 || !origin.stdout.trim()) return false
    const repo: unknown = JSON.parse(
      await context.gh(context.cwd, ['repo', 'view', origin.stdout.trim(), '--json', 'nameWithOwner']),
    )
    if (
      repo === null ||
      typeof repo !== 'object' ||
      !('nameWithOwner' in repo) ||
      repo.nameWithOwner !== scope.repository
    )
      return false
    const [head, branch, status, remote] = await Promise.all([
      context.git(context.cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
      context.git(context.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      context.git(context.cwd, ['status', '--porcelain', '--untracked-files=all']),
      context.git(context.cwd, ['ls-remote', '--refs', 'origin', `refs/heads/${base}`]),
    ])
    return (
      [head, branch, status, remote].every((item) => item.code === 0) &&
      head.stdout.trim() === tip &&
      branch.stdout.trim() === 'HEAD' &&
      status.stdout === '' &&
      remote.stdout.trim() === `${tip}\trefs/heads/${base}`
    )
  } catch {
    return false
  }
}

/** Reobserve a successor integration at the canonical detached parent checkout. */
export async function observeParentSuccessorEffect(input: {
  authority: FeatureAuthority
  mandate: MandateRecord
  causal: WorkflowCausalContext
  control: Extract<CanonicalRecord, { kind: 'operator-control' }>
  result: Extract<CanonicalRecord, { kind: 'action-receipt' }>
}): Promise<
  | { ok: true; value: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }> }
  | { ok: false; reason: string }
> {
  const fail = () => ({ ok: false as const, reason: 'context-succession-observation-unconfirmed' })
  try {
    const { authority, mandate, causal, control, result } = input
    const { context, scope } = authority
    const payload = result.payload
    const issue = causal.histories.find(
      (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
    )
    if (
      issue === undefined ||
      mandate.payload.branch !== null ||
      payload.action !== 'integrate' ||
      payload.phase !== 'result' ||
      !sameRef(payload.mandate, { scope, kind: 'mandate', recordId: mandate.recordId }) ||
      !integrationReceiptEligible(result) ||
      !authenticateWorkflowReceiptPair(issue, result).ok ||
      payload.admission?.published !== true ||
      payload.admission.remoteBranch !== null ||
      payload.admission.remoteTip === null
    )
      return fail()
    const tip = payload.admission.remoteTip
    if (!(await observeParentSuccessorBaseline({ authority, base: mandate.payload.base, head: tip }))) return fail()
    const read = await createInstalledUwReadPort({ cwd: context.cwd, gh: context.gh }).readUw(scope)
    const selected = currentParentIntegration(read, payload.inputs.manifest.code.base, tip)
    if (
      !selected.ok ||
      selected.value === null ||
      !sameRef(selected.value.source.record, { scope, kind: 'action-receipt', recordId: result.recordId })
    )
      return fail()
    if (selected.value.code.head !== tip) return fail()
    const delivery = await successorOwnDelivery(authority, causal.histories, issue)
    if (
      'kind' in delivery ||
      delivery.uw.repository !== scope.repository ||
      delivery.uw.target !== scope.target ||
      delivery.pullRequests.length !== 0 ||
      delivery.integrations.some(
        (item) => !sameRef(item.source.record, { scope, kind: 'action-receipt', recordId: result.recordId }),
      )
    )
      return fail()
    return {
      ok: true,
      value: {
        kind: 'admitted-successor-delivery',
        control: { scope, kind: 'operator-control', recordId: control.recordId },
        receipt: {
          source: 'record',
          record: { scope, kind: 'action-receipt', recordId: result.recordId },
          selector: '/payload',
          digest: canonicalValueDigest(payload),
        },
        candidate: { kind: 'parent', repository: scope.repository, head: tip, clean: true, remoteBase: tip },
        delivery,
        binding: { kind: 'absent' },
      },
    }
  } catch {
    return fail()
  }
}
