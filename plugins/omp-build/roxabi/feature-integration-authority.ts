import { canonicalValueDigest } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { explicitParentHistories } from './feature-context.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

type Input = {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh: (cwd: string, args: string[]) => Promise<string>
}
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

export function integrationAuthority(
  input: Input,
  context: NonImplementPublication,
  mandateRef: { scope: ScopedRecordRef['scope']; recordId: string },
  uw: Scope,
  read: UwRead,
  accepted: AcceptedOwnSpec,
): () => Promise<boolean> {
  async function authority(): Promise<boolean> {
    const options = { ...withRoxabiGitHubPolicy({ cwd: input.cwd, gh: context.gh }), gh: context.gh }
    const history = await context.loaded.readComposedWorkflowHistory([mandateRef.scope], options)
    if (!history.ok || !history.histories[0]) return false
    const mandateHistory = history.histories[0]
    const freshMandate = mandateHistory.operations.find(
      (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === mandateRef.recordId,
    )?.record
    if (freshMandate?.kind !== 'mandate') return false
    const parents = await explicitParentHistories(context.loaded, freshMandate, options)
    if (!parents.ok) return false
    const causal = await readFreshUwCausalContext(mandateRef.scope, [mandateHistory, ...parents.parents], options)
    if (!causal.ok) return false
    const currentMandate = context.loaded.selectApplicableMandate(mandateHistory, parents.parents, causal.value)
    return (
      currentMandate.status === 'applicable' &&
      currentMandate.mandate?.recordId === mandateRef.recordId &&
      cwdInhibition(input.cwd) === undefined &&
      inhibition(mandateRef.scope) === undefined
    )
  }
  return async () => {
    if (
      input.result.canPublishContext?.() === false ||
      cwdInhibition(input.cwd) !== undefined ||
      inhibition(mandateRef.scope) !== undefined
    )
      return false
    if (!(await authority())) return false
    const current = await createInstalledUwReadPort({ cwd: input.cwd, gh: input.gh }).readUw(uw)
    if (
      current.observation.status !== 'complete' ||
      current.accepted.status !== 'accepted' ||
      !equal(current.accepted.value, accepted)
    )
      return false
    return (
      accepted.children.every((commitment) => {
        const prior = [...read.completion.completions.values()].find((item) => equal(item.uw, commitment.scope))
        const fresh = [...current.completion.completions.values()].find((item) => equal(item.uw, commitment.scope))
        return prior?.state === 'complete' && equal(prior, fresh)
      }) && !('reason' in (await resolvePublication(input)))
    )
  }
}
