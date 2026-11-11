import { canonicalValueDigest, createUwDeliveryFactReader, sameScope } from '../dist/contracts.js'
import type { UwDeliveryFacts } from '../engine/uw-completion-types.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { readSuccessionBasis, type SuccessionBasis } from './feature-succession.ts'
import { composeObservedUwCausalContext, mergeFixUwHistories } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead } from './uw-contract.ts'

export type ConfirmedSuccessor = {
  history: FeatureAuthority['history']
  parents: FeatureAuthority['parentHistories']
  basis: SuccessionBasis
  delivery: UwDeliveryFacts
}

export async function successorOwnDelivery(
  authority: FeatureAuthority,
  histories: readonly FeatureAuthority['history'][],
  own: FeatureAuthority['history'],
): Promise<UwDeliveryFacts | ContinueFeatureResult> {
  // Ordinary completion omits terminal UW delivery scopes; request factual bindings explicitly.
  const options = withRoxabiGitHubPolicy({
    cwd: authority.context.cwd,
    gh: authority.context.gh,
    readAuthor: own.source.expectedAuthor,
  })
  const observed = await createUwDeliveryFactReader(options).read(authority.scope, histories)
  if (!observed.ok)
    return { kind: 'blocked', reason: 'successor-delivery-unconfirmed', diagnostics: observed.diagnostics }
  const merged = mergeFixUwHistories(histories, observed.value.histories)
  return merged.ok
    ? observed.value.facts
    : {
        kind: 'blocked',
        reason: merged.diagnostics[0] ?? 'successor-observation-unconfirmed',
        diagnostics: merged.diagnostics.slice(1).map((message) => ({ code: message, message })),
      }
}

export async function currentSuccessionBasis(
  authority: FeatureAuthority,
  read: UwRead,
  history: FeatureAuthority['history'],
  parents: FeatureAuthority['parentHistories'],
): Promise<{ basis: SuccessionBasis; histories: readonly FeatureAuthority['history'][] } | ContinueFeatureResult> {
  if (!sameScope(read.uw, authority.scope) || !sameScope(history.source.scope, authority.scope))
    return { kind: 'blocked', reason: 'successor-scope-mismatch' }
  const causal = await composeObservedUwCausalContext(read, [history, ...parents], {
    cwd: authority.context.cwd,
    gh: authority.context.gh,
  })
  if (!causal.ok)
    return {
      kind: 'blocked',
      reason: causal.diagnostics[0] ?? 'successor-observation-unconfirmed',
      diagnostics: causal.diagnostics.slice(1).map((message) => ({ code: message, message })),
    }
  const basis = readSuccessionBasis(history, causal.value.histories)
  return basis.ok
    ? { basis: basis.value, histories: causal.value.histories }
    : { kind: 'blocked', reason: 'successor-antecedent-unconfirmed', diagnostics: basis.diagnostics }
}

export async function confirmSuccessorHistories(
  authority: FeatureAuthority,
  latest: UwRead,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
  basis: SuccessionBasis,
): Promise<ConfirmedSuccessor | ContinueFeatureResult> {
  const options = {
    ...withRoxabiGitHubPolicy({ cwd: authority.context.cwd, gh: authority.context.gh }),
    gh: authority.context.gh,
  }
  const histories = await authority.context.engine.readComposedWorkflowHistory([authority.scope], options)
  if (!histories.ok || histories.histories[0] === undefined) return { kind: 'blocked', reason: 'successor-unconfirmed' }
  const freshHistory = histories.histories[0]
  const parents = await mandateParentHistories(authority.context.engine, freshHistory, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  if (
    canonicalValueDigest(freshHistory) !== canonicalValueDigest(history) ||
    canonicalValueDigest(parents.parents) !== canonicalValueDigest(parentHistories)
  )
    return { kind: 'blocked', reason: 'successor-ancestry-changed' }
  const coherent = await composeObservedUwCausalContext(latest, [freshHistory, ...parents.parents], options)
  if (!coherent.ok) return { kind: 'blocked', reason: 'successor-observation-unconfirmed' }
  const delivery = await successorOwnDelivery(authority, coherent.value.histories, freshHistory)
  if ('kind' in delivery) return delivery
  return { history: freshHistory, parents: parents.parents, basis, delivery }
}
