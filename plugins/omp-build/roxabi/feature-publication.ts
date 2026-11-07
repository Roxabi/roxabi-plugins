import { explicitParentHistories } from './feature-context.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'
import { readFixUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { GitRunner } from './workflow-checkout.ts'

export async function authorizedImplementationPush(
  binding: ImplementationResultBinding,
  cwd: string,
): Promise<boolean> {
  if (cwdInhibition(cwd) !== undefined || inhibition(binding.mandate.scope) !== undefined) return false
  const options = { ...withRoxabiGitHubPolicy({ cwd, gh: binding.gh }), gh: binding.gh }
  const fresh = await binding.loaded.readComposedWorkflowHistory([binding.mandate.scope], options)
  if (!fresh.ok || !fresh.histories[0]) return false
  const freshMandate =
    fresh.histories[0].operations.find(
      (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === binding.mandate.recordId,
    )?.record ?? null
  if (freshMandate === null) return false
  const freshParents = await explicitParentHistories(binding.loaded, freshMandate, options)
  if (!freshParents.ok) return false
  const causal = await readFixUwCausalContext([fresh.histories[0], ...freshParents.parents], [], options)
  if (!causal.ok) return false
  const current = binding.loaded.selectApplicableMandate(fresh.histories[0], freshParents.parents, causal.value)
  return (
    cwdInhibition(cwd) === undefined &&
    inhibition(binding.mandate.scope) === undefined &&
    current.status === 'applicable' &&
    current.mandate?.recordId === binding.mandate.recordId
  )
}

export async function proveAuthorizedBranch(
  git: GitRunner,
  cwd: string,
  branch: string,
  tip: string,
  authorizePush: () => Promise<boolean>,
): Promise<{ ok: true; remoteTip: string } | { ok: false; reason: string }> {
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== branch)
    return { ok: false, reason: 'implementation-branch-mismatch' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { ok: false, reason: 'implementation-head-mismatch' }
  const observed = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const observedTip = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (observed.code === 0 && observedTip === tip) return { ok: true, remoteTip: observedTip }
  if (!(await authorizePush())) return { ok: false, reason: 'implementation-admission-refused' }
  const pushed = await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.code !== 0) return { ok: false, reason: 'implementation-not-remote' }
  const remote = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || remoteTip !== tip) return { ok: false, reason: 'implementation-not-remote' }
  return { ok: true, remoteTip }
}
