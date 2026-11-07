import { createHash } from 'node:crypto'
import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import {
  bindExternalRef,
  type GitHubOptions,
  nativeObservationDigest,
  readUwCompletionObservation,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import { defaultGh } from './feature-engine.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { exactNewIntent, same } from './uw-cause-creation-support.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import { rootObservation } from './uw-installed-observation.ts'

function observationDigest(uw: Scope, observation: UwCompletionObservation): string {
  const native = rootObservation(uw, { graph: observation.graph })
  return nativeObservationDigest({
    ...native,
    labels: [...native.labels],
    children: [...native.children],
    blockers: [...native.blockers],
  })
}

/** Re-read the entire retained post-assessment cut before publishing the confirmed creation intent. */
export async function assertComposedBefore(input: {
  github: GitHubOptions
  before: Extract<UwCompletionObservation, { status: 'complete' }>
  parent: Scope
  signal: AbortSignal
}): Promise<void> {
  if (input.signal.aborted) throw new Error('composed-cause-cancelled')
  const after = await readUwCompletionObservation(
    input.parent,
    input.github,
    (histories) => loadReviewClassCatalogues({ histories, cwd: input.github.cwd, gh: input.github.gh ?? defaultGh() }),
    input.before.graph.nodes.map((node) => node.uw),
  )
  if (
    input.signal.aborted ||
    after.status !== 'complete' ||
    after.graph.nodes.length !== input.before.graph.nodes.length ||
    after.histories.length !== input.before.histories.length
  )
    throw new Error('composed-cause-observation-stale')
  for (const prior of input.before.histories) {
    const current = after.histories.find((history) => same(history.source.scope, prior.source.scope))
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(prior))
      throw new Error('composed-cause-observation-stale')
  }
  for (const prior of input.before.graph.nodes) {
    const current = after.graph.nodes.find((node) => same(node.uw, prior.uw))
    if (current === undefined || observationDigest(prior.uw, input.before) !== observationDigest(prior.uw, after))
      throw new Error('composed-cause-observation-stale')
  }
}

/** Guard only a confirmed composed invocation; it never admits arbitrary active-parent insertion. */
export function composedCauseEffectGuard(input: {
  github: GitHubOptions
  before: Extract<UwCompletionObservation, { status: 'complete' }>
  intent: Extract<CanonicalRecord, { kind: 'cause-operation' }>
  signal: AbortSignal
}): CauseEffectGuard {
  const proposal = input.intent.payload.proposal
  if (
    proposal.operation !== 'create' ||
    proposal.parentAcceptance === null ||
    proposal.creation.parentObservation?.state !== 'active'
  )
    throw new Error('composed-parent-consent-missing')
  const consent = proposal.parentAcceptance
  const origin = { repository: input.intent.repository, target: input.intent.target }
  const parentHistory = input.before.histories.find((history) => same(history.source.scope, consent.parent))
  const parentNative = rootObservation(consent.parent, { graph: input.before.graph })
  if (
    !same(consent.parent, proposal.creation.parentObservation.parent) ||
    parentHistory === undefined ||
    consent.nativeObservationDigest !==
      nativeObservationDigest({
        ...parentNative,
        labels: [...parentNative.labels],
        children: [...parentNative.children],
        blockers: [...parentNative.blockers],
      }) ||
    consent.historyDigest !== createHash('sha256').update(JSON.stringify(parentHistory)).digest('hex')
  )
    throw new Error('composed-parent-consent-mismatch')
  const scopeOf = (issue: IssueRef): Scope => ({
    repository: issue.repository,
    target: `${issue.repository}#${issue.number}`,
  })
  const restoredChildren = (
    scope: Scope,
    observation: UwCompletionObservation,
    sameIssue: (candidate: IssueRef) => boolean,
    children: IssueRef[],
  ) => {
    const prior = rootObservation(scope, { graph: input.before.graph })
    for (const childIssue of proposal.writes.relations.addChildren) {
      const childScope = scopeOf(childIssue)
      if (
        !input.before.graph.nodes.some((node) => same(node.uw, childScope)) ||
        !observation.graph.nodes.some((node) => same(node.uw, childScope))
      )
        continue
      const oldChild = rootObservation(childScope, { graph: input.before.graph })
      const newChild = rootObservation(childScope, { graph: observation.graph })
      if (
        oldChild.parent !== null &&
        same(scopeOf(oldChild.parent), scope) &&
        newChild.parent !== null &&
        sameIssue(newChild.parent) &&
        prior.children.some((item) => item.repository === childIssue.repository && item.number === childIssue.number) &&
        !children.some((item) => item.repository === childIssue.repository && item.number === childIssue.number)
      )
        children = [...children, childIssue]
    }
    return children
  }
  const digest = (scope: Scope, observation: UwCompletionObservation, created: IssueRef | null) => {
    const current = rootObservation(scope, { graph: observation.graph })
    const sameIssue = (candidate: IssueRef) =>
      created !== null && candidate.repository === created.repository && candidate.number === created.number
    let children =
      created !== null && same(scope, consent.parent)
        ? current.children.filter((item) => !sameIssue(item))
        : [...current.children]
    let parent = current.parent
    if (created !== null) {
      const prior = rootObservation(scope, { graph: input.before.graph })
      const plannedChild = proposal.writes.relations.addChildren.some((item) => same(scopeOf(item), scope))
      if (plannedChild && parent !== null && sameIssue(parent)) parent = prior.parent
      children = restoredChildren(scope, observation, sameIssue, children)
    }
    const blockers =
      created !== null &&
      same(scope, origin) &&
      proposal.creation.kind === 'sister' &&
      proposal.creation.relation === 'original-blocked-by-sister'
        ? current.blockers.filter((item) => !sameIssue(item))
        : current.blockers
    return nativeObservationDigest({
      ...current,
      parent,
      labels: [...current.labels],
      children,
      blockers: [...blockers],
    })
  }
  const childHistoryValid = (history: DecodedHistory) => {
    if (history.operations.length === 0) return history.source.comments.length === 0 && history.diagnostics.length === 0
    if (history.operations.length !== 1) return false
    const operation = history.operations[0]
    if (operation === undefined) return false
    if (
      operation.authority === 'foreign' ||
      operation.status !== 'complete' ||
      operation.record?.kind !== 'spec-identity' ||
      operation.record.operationId !== proposal.operationId ||
      operation.record.payload.event !== 'allocate' ||
      operation.record.payload.predecessor !== null ||
      JSON.stringify(operation.record.payload.allocations) !== JSON.stringify(proposal.allocation.assignments) ||
      operation.record.payload.proposalDigest !== input.intent.payload.proposalDigest ||
      JSON.stringify(operation.record.payload.confirmation) !== JSON.stringify(input.intent.payload.confirmation)
    )
      return false
    const ids = new Set(operation.parts.map((part) => part.nativeId))
    return history.source.comments.every((comment) => ids.has(comment.nativeId)) && history.diagnostics.length === 0
  }
  const assertPriorHistories = (current: Extract<UwCompletionObservation, { status: 'complete' }>) => {
    for (const prior of input.before.histories) {
      const fresh = current.histories.find((history) => same(history.source.scope, prior.source.scope))
      if (
        fresh === undefined ||
        (same(prior.source.scope, origin)
          ? !exactNewIntent(prior, fresh, input.intent.recordId)
          : JSON.stringify(prior) !== JSON.stringify(fresh))
      )
        throw new Error('composed-cause-history-stale')
    }
  }
  const assertHistories = (current: Extract<UwCompletionObservation, { status: 'complete' }>, child: Scope | null) => {
    assertPriorHistories(current)
    for (const fresh of current.histories) {
      if (input.before.histories.some((prior) => same(prior.source.scope, fresh.source.scope))) continue
      if (child === null || !same(fresh.source.scope, child) || !childHistoryValid(fresh))
        throw new Error('composed-cause-history-stale')
    }
  }
  const assertNative = (
    current: Extract<UwCompletionObservation, { status: 'complete' }>,
    child: Scope | null,
    created: IssueRef | null,
  ) => {
    for (const prior of input.before.graph.nodes) {
      if (
        !current.graph.nodes.some((node) => same(node.uw, prior.uw)) ||
        digest(prior.uw, input.before, null) !== digest(prior.uw, current, created)
      )
        throw new Error('composed-cause-native-stale')
    }
    for (const fresh of current.graph.nodes)
      if (
        !input.before.graph.nodes.some((prior) => same(prior.uw, fresh.uw)) &&
        (child === null || !same(fresh.uw, child))
      )
        throw new Error('composed-cause-native-stale')
  }
  return async ({ created }) => {
    if (input.signal.aborted) throw new Error('composed-cause-cancelled')
    const child = created === null ? null : scopeOf(created)
    const seeds = [...input.before.graph.nodes.map((node) => node.uw), ...(child === null ? [] : [child])]
    const current = await readUwCompletionObservation(
      consent.parent,
      input.github,
      (histories) =>
        loadReviewClassCatalogues({ histories, cwd: input.github.cwd, gh: input.github.gh ?? defaultGh() }),
      seeds,
    )
    if (input.signal.aborted || current.status !== 'complete') throw new Error('composed-cause-observation-incomplete')
    const own = current.histories.find((history) => same(history.source.scope, origin))
    const bound =
      own === undefined
        ? null
        : bindExternalRef({ scope: origin, recordId: input.intent.recordId, kind: 'cause-operation' }, own)
    if (bound === null || !bound.ok || JSON.stringify(bound.value) !== JSON.stringify(input.intent))
      throw new Error('composed-cause-intent-unconfirmed')
    assertHistories(current, child)
    assertNative(current, child, created)
  }
}
