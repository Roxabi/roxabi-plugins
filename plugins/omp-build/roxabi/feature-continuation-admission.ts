import { readWorkflowBinding } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { MandateSelection } from '../engine/workflow-mandate.ts'
import { causalRefusal } from './causal-refusal.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { asHistory } from './feature-delivery-facts.ts'
import { type Contracts, defaultGh, loadContracts, type Scope } from './feature-engine.ts'
import { type ResolvedTarget, resolveFeatureNativeTarget } from './feature-native-target.ts'
import { issueReference } from './feature-selection.ts'
import { type FixUwCausalContext, readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { defaultGit, type SessionWorktreeIdentity, sessionWorktreeIdentity } from './workflow-checkout.ts'

export type FeatureContext = Readonly<{
  cwd: ContinueFeatureInput['cwd']
  git: NonNullable<ContinueFeatureInput['git']>
  gh: NonNullable<ContinueFeatureInput['gh']>
  engine: Contracts
}>

export type FeatureAuthority = {
  context: FeatureContext
  identity: SessionWorktreeIdentity
  onPrincipal: boolean
  target: ResolvedTarget
  scope: Scope
  history: DecodedHistory
  parentHistories: DecodedHistory[]
  causal: FixUwCausalContext
  selection: MandateSelection
}

export async function resolveFeatureAuthority(
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
): Promise<FeatureAuthority | ContinueFeatureResult> {
  const framing = authorityFraming(input, exactMandateRef)
  if (framing !== null) return framing
  const git = input.git ?? defaultGit()
  const gh = input.gh ?? defaultGh()
  const identity = await sessionWorktreeIdentity(git, input.cwd)
  const onPrincipal = identity.ok ? identity.onPrincipal : input.principal === true
  const context = await featureContext(input, git, gh)
  if ('kind' in context) return context
  const resolved = await resolveNativeAuthority(input.reference, exactMandateRef, context)
  if ('kind' in resolved) return resolved
  const histories = await readHistoryAuthority(exactMandateRef, resolved, context)
  if ('kind' in histories) return histories
  return { identity, onPrincipal, context, ...resolved, ...histories }
}

function authorityFraming(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
): ContinueFeatureResult | null {
  if (exactMandateRef !== undefined || issueReference(input.reference)) return null
  if (input.control === 'abandon') {
    return { kind: 'blocked', reason: 'abandon-uncertain' }
  }
  return { kind: 'framing', source: { kind: 'free-text', acceptedArgs: input.reference } }
}

async function featureContext(
  input: ContinueFeatureInput,
  git: NonNullable<ContinueFeatureInput['git']>,
  gh: NonNullable<ContinueFeatureInput['gh']>,
): Promise<FeatureContext | ContinueFeatureResult> {
  const engine = await loadContracts()
  if (!('missing' in engine)) return { cwd: input.cwd, git, gh, engine }
  return { kind: 'blocked', reason: `engine-unavailable:${engine.missing}` }
}

/** Revocation needs the native target, not delivery authority or its Accepted Spec. */
export async function resolveFeatureRevocation(
  input: ContinueFeatureInput,
): Promise<{ scope: Scope; mandate?: ScopedRecordRef & { kind: 'mandate' } } | ContinueFeatureResult> {
  if (!issueReference(input.reference)) return { kind: 'blocked', reason: 'abandon-uncertain' }
  const gh = input.gh ?? defaultGh()
  const engine = await loadContracts()
  if ('missing' in engine) return { kind: 'blocked', reason: `engine-unavailable:${engine.missing}` }
  const context = { cwd: input.cwd, gh, engine }
  const target = await resolveFeatureNativeTarget(input.reference, context)
  if ('kind' in target) return target
  if (target.status === 'issue') return { scope: target.scope }
  const bound = await readWorkflowBinding(target.scope, withRoxabiGitHubPolicy(context))
  if (!bound.ok) return { kind: 'blocked', reason: bound.status === 'absent' ? 'binding-missing' : bound.status }
  const { binding } = bound.value
  if (binding.kind !== 'workflow-binding' || binding.payload.mandate.kind !== 'mandate')
    return { kind: 'blocked', reason: 'binding-incomplete' }
  const mandate = { ...binding.payload.mandate, kind: 'mandate' as const }
  return { scope: mandate.scope, mandate }
}

type NativeAuthority = { target: ResolvedTarget; scope: Scope }

async function resolveNativeAuthority(
  reference: string,
  exactMandateRef: ScopedRecordRef | undefined,
  context: FeatureContext,
): Promise<NativeAuthority | ContinueFeatureResult> {
  if (exactMandateRef !== undefined && exactMandateRef.kind !== 'mandate') {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  const target = await resolveFeatureNativeTarget(reference, context, exactMandateRef?.scope)
  if ('kind' in target) return target
  const scope = await resolvePullRequestScope(target, context)
  if ('kind' in scope) return scope
  if (
    exactMandateRef !== undefined &&
    (scope.repository !== exactMandateRef.scope.repository || scope.target !== exactMandateRef.scope.target)
  ) {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  return { target, scope }
}

async function resolvePullRequestScope(
  target: ResolvedTarget,
  context: FeatureContext,
): Promise<Scope | ContinueFeatureResult> {
  if (target.status !== 'pull-request') return target.scope
  const bound = await readWorkflowBinding(target.scope, withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }))
  if (!bound.ok) {
    return { kind: 'blocked', reason: bound.status === 'absent' ? 'binding-missing' : bound.status }
  }
  const history = asHistory(bound.value.history)
  return history === null ? { kind: 'blocked', reason: 'binding-incomplete' } : history.source.scope
}

async function readHistoryAuthority(
  exactMandateRef: ScopedRecordRef | undefined,
  native: NativeAuthority,
  context: FeatureContext,
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'> | ContinueFeatureResult> {
  const options = { ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }), gh: context.gh }
  const composed = await context.engine.readComposedWorkflowHistory([native.scope], options)
  if (!composed.ok || composed.histories[0] === undefined) {
    return { kind: 'blocked', reason: composed.ok ? 'incomplete' : composed.reason }
  }
  return selectHistoryAuthority(exactMandateRef, native, context, composed.histories[0], options)
}

async function selectHistoryAuthority(
  exactMandateRef: ScopedRecordRef | undefined,
  native: NativeAuthority,
  context: FeatureContext,
  history: DecodedHistory,
  options: { cwd: string; gh: NonNullable<ContinueFeatureInput['gh']> },
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'> | ContinueFeatureResult> {
  const parents = await mandateParentHistories(context.engine, history, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const causal = await readFreshUwCausalContext(native.scope, [history, ...parents.parents], options)
  if (!causal.ok) return { kind: 'blocked', ...causalRefusal(causal) }
  const selection = context.engine.selectApplicableMandate(history, parents.parents, causal.value)
  if (exactMandateRef !== undefined) {
    if (selection.status !== 'applicable') return { kind: 'blocked', reason: `exact-mandate-${selection.reason}` }
    if (selection.mandate === null || selection.mandate.recordId !== exactMandateRef.recordId) {
      return { kind: 'blocked', reason: 'exact-mandate-not-applicable' }
    }
  }
  return { history, parentHistories: parents.parents, causal: causal.value, selection }
}
