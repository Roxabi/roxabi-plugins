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

async function checkCurrentCommitments(input: Input, uw: Scope, read: UwRead, accepted: AcceptedOwnSpec) {
  const current = await createInstalledUwReadPort({ cwd: input.cwd, gh: input.gh }).readUw(uw)
  if (current.observation.status !== 'complete')
    return { ok: false as const, reason: 'integration-authority-unreadable' }
  if (current.accepted.status !== 'accepted' || !equal(current.accepted.value, accepted))
    return { ok: false as const, reason: 'integration-authority-withdrawn' }
  const unchanged = accepted.children.every((commitment) => {
    const prior = [...read.completion.completions.values()].find((item) => equal(item.uw, commitment.scope))
    const fresh = [...current.completion.completions.values()].find((item) => equal(item.uw, commitment.scope))
    return prior?.state === 'complete' && equal(prior, fresh)
  })
  return unchanged ? { ok: true as const } : { ok: false as const, reason: 'integration-authority-withdrawn' }
}

async function checkFreshMandate(
  input: Input,
  context: NonImplementPublication,
  mandateRef: { scope: ScopedRecordRef['scope']; recordId: string },
) {
  const options = { ...withRoxabiGitHubPolicy({ cwd: input.cwd, gh: context.gh }), gh: context.gh }
  const history = await context.loaded.readComposedWorkflowHistory([mandateRef.scope], options)
  if (!history.ok || !history.histories[0]) return { ok: false as const, reason: 'integration-authority-unreadable' }
  const mandateHistory = history.histories[0]
  const freshMandate = mandateHistory.operations.find(
    (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === mandateRef.recordId,
  )?.record
  if (freshMandate?.kind !== 'mandate') return { ok: false as const, reason: 'integration-authority-unreadable' }
  const parents = await explicitParentHistories(context.loaded, freshMandate, options)
  if (!parents.ok) return { ok: false as const, reason: 'integration-authority-unreadable' }
  const causal = await readFreshUwCausalContext(mandateRef.scope, [mandateHistory, ...parents.parents], options)
  if (!causal.ok) return { ok: false as const, reason: 'integration-authority-unreadable' }
  const resolution = context.loaded.startResolution(causal.value.histories, input.start)
  if (!resolution.ok) return { ok: false as const, reason: 'integration-authority-unreadable' }
  if (resolution.value !== null) return { ok: false as const, reason: 'integration-start-resolved' }
  const currentMandate = context.loaded.selectApplicableMandate(mandateHistory, parents.parents, causal.value)
  if (cwdInhibition(input.cwd) !== undefined || inhibition(mandateRef.scope) !== undefined)
    return { ok: false as const, reason: 'integration-local-inhibition' }
  if (currentMandate.status !== 'applicable' || currentMandate.mandate?.recordId !== mandateRef.recordId)
    return { ok: false as const, reason: 'integration-authority-withdrawn' }
  return { ok: true as const }
}

export function integrationAuthority(
  input: Input,
  context: NonImplementPublication,
  mandateRef: { scope: ScopedRecordRef['scope']; recordId: string },
  uw: Scope,
  read: UwRead,
  accepted: AcceptedOwnSpec,
): () => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async () => {
    if (
      input.result.canPublishContext?.() === false ||
      cwdInhibition(input.cwd) !== undefined ||
      inhibition(mandateRef.scope) !== undefined
    )
      return { ok: false, reason: 'integration-local-inhibition' }
    const mandate = await checkFreshMandate(input, context, mandateRef)
    if (!mandate.ok) return mandate
    const commitments = await checkCurrentCommitments(input, uw, read, accepted)
    if (!commitments.ok) return commitments
    const publication = await resolvePublication(input)
    if ('reason' in publication)
      return {
        ok: false,
        reason:
          publication.reason === 'action-start-resolved'
            ? 'integration-start-resolved'
            : 'integration-authority-unreadable',
      }
    return { ok: true }
  }
}
