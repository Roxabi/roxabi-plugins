import { explicitParentHistories } from './feature-context.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import type { ImplementationResultBinding } from './feature-result-binding.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

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
  const causal = await readFreshUwCausalContext(
    binding.mandate.scope,
    [fresh.histories[0], ...freshParents.parents],
    options,
  )
  if (!causal.ok) return false
  const current = binding.loaded.selectApplicableMandate(fresh.histories[0], freshParents.parents, causal.value)
  return (
    cwdInhibition(cwd) === undefined &&
    inhibition(binding.mandate.scope) === undefined &&
    current.status === 'applicable' &&
    current.mandate?.recordId === binding.mandate.recordId
  )
}
