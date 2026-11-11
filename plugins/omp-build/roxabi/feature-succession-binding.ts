// Source: plugins/omp-build/roxabi/workflow.ts:1089-1139,1360-1419
import { randomUUID } from 'node:crypto'
import type { NativePullRequestFacts } from '../adapters/github-workflow/types.ts'
import {
  canonicalValueDigest,
  readNativePullRequestFacts,
  sameScope,
  selectWorkflowBinding,
  selectWorkflowBindingClaims,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { NativeDeliveryPullRequest } from '../engine/uw-completion-types.ts'
import { discoverDeliveryPr } from './feature-delivery-discovery.ts'
import { type Contracts, type History, type HistoryRecord, publishRecord, type Scope } from './feature-engine.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

type BindingContext = {
  loaded: Contracts
  gh: Gh
  cwd: string
  successorScope: Scope
  branch: string | null
  base: string
}
type Failure = { ok: false; reason: string }
export type SuccessorBindingPlan =
  | { kind: 'absent'; number: null }
  | { kind: 'pull-request'; number: number; scope: Scope; native: NativePullRequestFacts; proof: string }

export async function prepareSuccessorBinding(
  context: BindingContext,
  issueHistory: History,
  antecedent: ExternalRecordRef & { kind: 'mandate' },
  observed: readonly NativeDeliveryPullRequest[],
): Promise<{ ok: true; plan: SuccessorBindingPlan } | Failure> {
  const discovered = await bindingDestination(context)
  if (!discovered.ok) return discovered
  if (observed.length > 1) return { ok: false, reason: 'successor-binding-commitments-changed' }
  const scope =
    discovered.number === null ? null : context.loaded.githubScope(context.successorScope.repository, discovered.number)
  if (observed.some((prior) => scope === null || !sameScope(prior.pullRequest, scope)))
    return { ok: false, reason: 'successor-binding-commitments-changed' }
  if (discovered.number === null || scope === null) return { ok: true, plan: { kind: 'absent', number: null } }
  const facts = await readBindingFacts(context, discovered.number, scope)
  if (!facts.ok) return facts
  const prior = observed[0]
  if (prior !== undefined && !matchesObserved(prior, facts.native))
    return { ok: false, reason: 'successor-binding-observation-changed' }
  const binding = selectWorkflowBinding({
    pullRequest: scope,
    histories: [facts.history, issueHistory],
    native: facts.native,
  })
  const refusal = initialBindingRefusal(binding, prior, antecedent)
  if (refusal !== null) return refusal
  return {
    ok: true,
    plan: {
      kind: 'pull-request',
      number: discovered.number,
      scope,
      native: facts.native,
      proof: bindingProof(facts.history),
    },
  }
}

function initialBindingRefusal(
  binding: ReturnType<typeof selectWorkflowBinding>,
  prior: NativeDeliveryPullRequest | undefined,
  antecedent: ExternalRecordRef & { kind: 'mandate' },
): Failure | null {
  if (
    (binding.status === 'bound' &&
      (prior === undefined ||
        !sameScope(binding.mandate.scope, antecedent.scope) ||
        binding.mandate.recordId !== antecedent.recordId)) ||
    (binding.status === 'absent' && prior !== undefined)
  )
    return { ok: false, reason: 'successor-binding-commitments-changed' }
  if (binding.status !== 'bound' && binding.status !== 'absent')
    return { ok: false, reason: `binding-${binding.status}` }
  return null
}

/** Check pinned PR facts, not the intentionally incomplete post-control binding chain. */
export async function recheckSuccessorBinding(
  context: BindingContext,
  plan: SuccessorBindingPlan,
): Promise<{ ok: true; history: History | null } | Failure> {
  const discovered = await bindingDestination(context)
  if (!discovered.ok) return discovered
  if (discovered.number !== plan.number) return { ok: false, reason: 'successor-binding-destination-changed' }
  if (plan.kind === 'absent') return { ok: true, history: null }
  const facts = await readBindingFacts(context, plan.number, plan.scope)
  if (!facts.ok) return facts
  const claims = selectWorkflowBindingClaims({
    pullRequest: plan.scope,
    histories: [facts.history],
    native: facts.native,
  })
  if (!Array.isArray(claims) && claims.status !== 'absent') return { ok: false, reason: `binding-${claims.status}` }
  if (
    canonicalValueDigest(facts.native) !== canonicalValueDigest(plan.native) ||
    bindingProof(facts.history) !== plan.proof
  )
    return { ok: false, reason: 'successor-binding-facts-changed' }
  return { ok: true, history: facts.history }
}

async function bindingDestination(context: BindingContext) {
  return context.branch === null
    ? { ok: true as const, number: null }
    : discoverDeliveryPr(context.gh, context.cwd, context.successorScope.repository, context.branch, context.base)
}

function matchesObserved(prior: NativeDeliveryPullRequest, native: NativePullRequestFacts): boolean {
  return (
    prior.branch === native.branch &&
    prior.base === native.base &&
    prior.head === native.head &&
    prior.baseTip === native.baseTip &&
    prior.state === native.state &&
    prior.mergeCommit === native.mergeCommit
  )
}

function bindingProof(history: History): string {
  return canonicalValueDigest({
    scope: history.source.scope,
    complete: history.source.complete,
    expectedAuthor: history.source.expectedAuthor,
    stopAuthor: history.source.stopAuthor,
    operations: history.operations.filter(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'workflow-binding' ||
          operation.record?.kind === 'workflow-binding' ||
          operation.claimedKinds.includes('workflow-binding')),
    ),
  })
}

async function readBindingFacts(
  context: BindingContext,
  number: number,
  scope: Scope,
): Promise<{ ok: true; native: NativePullRequestFacts; history: History } | Failure> {
  try {
    const native = await readNativePullRequestFacts(scope.repository, number, { cwd: context.cwd, gh: context.gh })
    if (native.state === 'CLOSED') return { ok: false, reason: 'pr-discovery-closed' }
    if (native.branch !== context.branch || native.base !== context.base)
      return { ok: false, reason: 'successor-binding-native-mismatch' }
    const read = await context.loaded.readComposedWorkflowHistory([scope], { cwd: context.cwd, gh: context.gh })
    if (!read.ok || !read.histories[0]) return { ok: false, reason: read.ok ? 'binding-incomplete' : read.reason }
    return { ok: true, native, history: read.histories[0] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'successor-binding-unreadable' }
  }
}

export async function preserveSuccessorBinding(
  context: BindingContext,
  plan: SuccessorBindingPlan,
  successorId: string,
  issueHistory: History,
): Promise<{ ok: true } | Failure> {
  const checked = await recheckSuccessorBinding(context, plan)
  if (!checked.ok) return checked
  if (plan.kind === 'absent') return { ok: true }
  if (checked.history === null) return { ok: false, reason: 'binding-incomplete' }
  const prScope = plan.scope
  const recordId = randomUUID()
  const binding = {
    repository: prScope.repository,
    target: prScope.target,
    version: 1 as const,
    recordId,
    runId: recordId,
    operationId: recordId,
    kind: 'workflow-binding' as const,
    payload: {
      mandate: { scope: context.successorScope, recordId: successorId, kind: 'mandate' as const },
      branch: plan.native.branch,
      base: plan.native.base,
    },
  } satisfies Omit<Extract<HistoryRecord, { kind: 'workflow-binding' }>, 'inputs'>
  return publishRecord(context.loaded, checked.history, binding, context.gh, context.cwd, [issueHistory])
}
