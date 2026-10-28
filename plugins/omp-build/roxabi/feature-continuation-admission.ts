import { readWorkflowBinding } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { MandateSelection } from '../engine/workflow-mandate.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { bindsOwnPause, inhibit } from './feature-control.ts'
import { asHistory } from './feature-delivery-facts.ts'
import { disarmKnownTarget, disarmUnresolved } from './feature-disarm.ts'
import { type Contracts, defaultGh, isRecord, loadContracts, type Scope } from './feature-engine.ts'
import { issueReference } from './feature-selection.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { defaultGit, type SessionWorktreeIdentity, sessionWorktreeIdentity } from './workflow-checkout.ts'

export type ResolvedTarget = Extract<
  Awaited<ReturnType<Contracts['resolveNativeTarget']>>,
  { status: 'issue' | 'pull-request' }
>

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
  const resolved = await resolveNativeAuthority(input, exactMandateRef, context)
  if ('kind' in resolved) return resolved
  const histories = await readHistoryAuthority(input, exactMandateRef, resolved, context)
  if ('kind' in histories) return histories
  return { identity, onPrincipal, context, ...resolved, ...histories }
}

function authorityFraming(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
): ContinueFeatureResult | null {
  if (exactMandateRef !== undefined || issueReference(input.reference)) return null
  if (input.control === 'pause' || input.control === 'abandon') {
    return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  return { kind: 'operator-decision', reason: 'needs-framing' }
}

async function featureContext(
  input: ContinueFeatureInput,
  git: NonNullable<ContinueFeatureInput['git']>,
  gh: NonNullable<ContinueFeatureInput['gh']>,
): Promise<FeatureContext | ContinueFeatureResult> {
  const engine = await loadContracts()
  if (!('missing' in engine)) return { cwd: input.cwd, git, gh, engine }
  if (input.control === 'pause' || input.control === 'abandon') {
    await disarmUnresolved(gh, input.cwd, input.reference)
    return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  return { kind: 'blocked', reason: `engine-unavailable:${engine.missing}` }
}

type NativeAuthority = { target: ResolvedTarget; scope: Scope }

async function resolveNativeAuthority(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  context: FeatureContext,
): Promise<NativeAuthority | ContinueFeatureResult> {
  const options = { cwd: context.cwd, gh: context.gh }
  const target =
    exactMandateRef === undefined
      ? await context.engine.resolveNativeTarget(input.reference, options)
      : await context.engine.resolveNativeScope(exactMandateRef.scope, options)
  if (!isResolvedTarget(target)) return { kind: 'blocked', reason: target.status }
  const exactProblem = await validateExactTarget(target, exactMandateRef, context)
  if (exactProblem !== null) return exactProblem
  const scope = await resolvePullRequestScope(input, target, context)
  if ('kind' in scope) return scope
  if (
    exactMandateRef !== undefined &&
    (scope.repository !== exactMandateRef.scope.repository || scope.target !== exactMandateRef.scope.target)
  ) {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  return { target, scope }
}

async function validateExactTarget(
  target: ResolvedTarget,
  exactMandateRef: ScopedRecordRef | undefined,
  context: FeatureContext,
): Promise<ContinueFeatureResult | null> {
  if (exactMandateRef === undefined) return null
  if (
    exactMandateRef.kind !== 'mandate' ||
    target.scope.repository !== exactMandateRef.scope.repository ||
    target.scope.target !== exactMandateRef.scope.target
  ) {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  return verifyExactRepository(context, exactMandateRef)
}

async function resolvePullRequestScope(
  input: ContinueFeatureInput,
  target: ResolvedTarget,
  context: FeatureContext,
): Promise<Scope | ContinueFeatureResult> {
  if (target.status !== 'pull-request') return target.scope
  const bound = await readWorkflowBinding(target.scope, withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }))
  if (!bound.ok) {
    if (input.control === 'pause' || input.control === 'abandon') {
      await disarmKnownTarget(context.gh, context.cwd, target, null)
      return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
    }
    return { kind: 'blocked', reason: bound.status === 'absent' ? 'binding-missing' : bound.status }
  }
  const history = asHistory(bound.value.history)
  return history === null ? { kind: 'blocked', reason: 'binding-incomplete' } : history.source.scope
}

async function verifyExactRepository(
  context: FeatureContext,
  ref: ScopedRecordRef,
): Promise<ContinueFeatureResult | null> {
  try {
    const current: unknown = JSON.parse(await context.gh(context.cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    if (!isRecord(current) || current.nameWithOwner !== ref.scope.repository) {
      return { kind: 'blocked', reason: 'repository-mismatch' }
    }
    return null
  } catch {
    return { kind: 'blocked', reason: 'repository-unreadable' }
  }
}

async function readHistoryAuthority(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  native: NativeAuthority,
  context: FeatureContext,
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'> | ContinueFeatureResult> {
  const control = input.control
  if (control === 'pause' || control === 'abandon') inhibit(native.scope, control)
  const options = { cwd: context.cwd, gh: context.gh }
  const composed = await context.engine.readComposedWorkflowHistory([native.scope], options)
  if (!composed.ok || composed.histories[0] === undefined) {
    return handleUnavailableHistory(input, native, context, composed.ok ? 'incomplete' : composed.reason)
  }
  return selectHistoryAuthority(input, exactMandateRef, native, context, composed.histories[0], options)
}

async function handleUnavailableHistory(
  input: ContinueFeatureInput,
  native: NativeAuthority,
  context: FeatureContext,
  reason: string,
): Promise<ContinueFeatureResult> {
  if (input.control === 'pause' || input.control === 'abandon') {
    await disarmKnownTarget(context.gh, context.cwd, native.target, null)
    return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  return { kind: 'blocked', reason }
}

async function selectHistoryAuthority(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  native: NativeAuthority,
  context: FeatureContext,
  history: DecodedHistory,
  options: { cwd: string; gh: NonNullable<ContinueFeatureInput['gh']> },
): Promise<Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'> | ContinueFeatureResult> {
  const parents = await mandateParentHistories(context.engine, history, options)
  if (!parents.ok) return disarmParents(input, native, context, parents.reason)
  const selection = context.engine.selectApplicableMandate(history, parents.parents)
  if (
    exactMandateRef === undefined &&
    input.control === 'pause' &&
    bindsOwnPause(context.engine, selection, history, native.scope)
  ) {
    return { kind: 'paused', confirmed: true, reason: 'paused' }
  }
  if (exactMandateRef !== undefined) {
    if (selection.status !== 'applicable') return { kind: 'blocked', reason: `exact-mandate-${selection.reason}` }
    if (selection.mandate === null || selection.mandate.recordId !== exactMandateRef.recordId) {
      return { kind: 'blocked', reason: 'exact-mandate-not-applicable' }
    }
  }
  return { history, parentHistories: parents.parents, selection }
}

async function disarmParents(
  input: ContinueFeatureInput,
  native: { target: ResolvedTarget; scope: Scope },
  context: FeatureContext,
  reason: string,
): Promise<ContinueFeatureResult> {
  if (input.control !== 'pause' && input.control !== 'abandon') return { kind: 'blocked', reason }
  await disarmKnownTarget(context.gh, context.cwd, native.target, null)
  return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
}

function isResolvedTarget(value: unknown): value is ResolvedTarget {
  return (
    isRecord(value) &&
    (value.status === 'issue' || value.status === 'pull-request') &&
    'scope' in value &&
    !('diagnostics' in value)
  )
}
