import { explicitParentHistories } from './feature-context.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

export type ImplementationEffectAuthority =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'implementation-local-inhibition'
        | 'implementation-authority-unreadable'
        | 'implementation-authority-withdrawn'
        | 'implementation-start-resolved'
    }

export async function implementationEffectAuthority(
  binding: ImplementationResultBinding,
  cwd: string,
): Promise<ImplementationEffectAuthority> {
  if (cwdInhibition(cwd) !== undefined || inhibition(binding.mandate.scope) !== undefined)
    return { ok: false, reason: 'implementation-local-inhibition' }
  const options = { ...withRoxabiGitHubPolicy({ cwd, gh: binding.gh }), gh: binding.gh }
  const fresh = await binding.loaded.readComposedWorkflowHistory([binding.mandate.scope], options)
  if (!fresh.ok || !fresh.histories[0]) return { ok: false, reason: 'implementation-authority-unreadable' }
  const freshMandate =
    fresh.histories[0].operations.find(
      (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === binding.mandate.recordId,
    )?.record ?? null
  if (freshMandate === null) return { ok: false, reason: 'implementation-authority-unreadable' }
  const freshParents = await explicitParentHistories(binding.loaded, freshMandate, options)
  if (!freshParents.ok) return { ok: false, reason: 'implementation-authority-unreadable' }
  const causal = await readFreshUwCausalContext(
    binding.mandate.scope,
    [fresh.histories[0], ...freshParents.parents],
    options,
  )
  if (!causal.ok) return { ok: false, reason: 'implementation-authority-unreadable' }
  const resolution = binding.loaded.startResolution(causal.value.histories, {
    scope: binding.receiptScope,
    recordId: binding.start.recordId,
    kind: 'action-receipt',
  })
  if (!resolution.ok) return { ok: false, reason: 'implementation-authority-unreadable' }
  if (resolution.value !== null) return { ok: false, reason: 'implementation-start-resolved' }
  const current = binding.loaded.selectApplicableMandate(fresh.histories[0], freshParents.parents, causal.value)
  if (cwdInhibition(cwd) !== undefined || inhibition(binding.mandate.scope) !== undefined)
    return { ok: false, reason: 'implementation-local-inhibition' }
  if (current.status !== 'applicable' || current.mandate?.recordId !== binding.mandate.recordId)
    return { ok: false, reason: 'implementation-authority-withdrawn' }
  return { ok: true }
}
