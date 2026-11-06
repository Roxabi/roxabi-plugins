import type { CodeRange } from './code-range-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import type {
  NativeDeliveryPullRequest,
  UwCompletion,
  UwCompletionObservation,
  UwDeliveryFacts,
} from './uw-completion-types.ts'
import type { UwResult } from './uw-diagnostics.ts'

export type ObservedCommitIndex = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>

function insertObservedCommit(
  repositories: Map<string, Map<string, readonly string[]>>,
  facts: UwDeliveryFacts,
  commit: UwDeliveryFacts['commits'][number],
): UwResult<null> {
  const failure = (message: string): UwResult<null> => ({
    ok: false,
    diagnostics: [
      {
        code: 'commit-observation-conflict',
        message,
        location: { kind: 'native', uw: facts.uw, connection: 'state' },
        related: [],
      },
    ],
  })
  if (commit.code.repository !== facts.uw.repository)
    return failure('Commit belongs to a different repository from its delivery observation')
  let commits = repositories.get(commit.code.repository)
  if (commits === undefined) {
    commits = new Map()
    repositories.set(commit.code.repository, commits)
  }
  const prior = commits.get(commit.code.commit)
  if (
    prior !== undefined &&
    (prior.length !== commit.parents.length || prior.some((parent, index) => parent !== commit.parents[index]))
  )
    return failure(`Conflicting ordered parents for ${commit.code.repository} ${commit.code.commit}`)
  if (prior === undefined) commits.set(commit.code.commit, commit.parents)
  return { ok: true, value: null }
}

export function buildObservedCommitIndex(observation: UwCompletionObservation): UwResult<ObservedCommitIndex> {
  if (observation.status !== 'complete') return { ok: false, diagnostics: [...observation.diagnostics] }
  const repositories = new Map<string, Map<string, readonly string[]>>()
  for (const facts of observation.delivery) {
    for (const commit of facts.commits) {
      const inserted = insertObservedCommit(repositories, facts, commit)
      if (!inserted.ok) return inserted
    }
  }
  return { ok: true, value: repositories }
}

export function observedAncestors(
  index: ObservedCommitIndex,
  repository: string,
  head: string,
): ReadonlySet<string> | null {
  const commits = index.get(repository)
  if (!commits?.has(head)) return null
  const pending = [head]
  const seen = new Set<string>()
  while (pending.length !== 0) {
    const current = pending.pop()
    if (current === undefined) break
    if (seen.has(current)) continue
    seen.add(current)
    for (const parent of commits.get(current) ?? []) pending.push(parent)
  }
  return seen
}

export function actualMergedLineage(
  facts: UwDeliveryFacts,
  pr: NativeDeliveryPullRequest,
  code: CodeRange,
  index: ObservedCommitIndex,
): boolean {
  if (
    pr.state !== 'MERGED' ||
    pr.mergeCommit === null ||
    pr.head !== code.head ||
    code.repository !== pr.pullRequest.repository
  )
    return false
  const merges = facts.commits.filter(
    (commit) => commit.code.repository === code.repository && commit.code.commit === pr.mergeCommit,
  )
  const [merge] = merges
  if (merges.length !== 1 || merge === undefined) return false
  const parents = merge.parents
  if (pr.mergeCommit === code.head) return observedAncestors(index, code.repository, code.head)?.has(code.base) === true
  if (parents[0] !== code.base) return false
  // GitHub's observed bound merge identity supplies the source link for a squash merge.
  return parents.length === 1 || (parents.length === 2 && parents[1] === code.head)
}

export function deliveredChildCommit(
  deliveries: readonly UwDeliveryFacts[],
  child: Extract<UwCompletion, { state: 'complete' }>,
  index: ObservedCommitIndex,
): string | null {
  if (child.role === 'parent') return child.code.head
  const facts = deliveries.find((item) => equalScope(item.uw, child.uw))
  if (facts === undefined) return null
  const matches = facts.pullRequests.filter(
    (pr) =>
      actualMergedLineage(facts, pr, child.code, index) &&
      child.sources.some((source) => source.kind === 'workflow-binding' && equalScope(source.scope, pr.pullRequest)),
  )
  const [match] = matches
  return matches.length === 1 && match !== undefined ? match.mergeCommit : null
}

export function deliveryFactsFor(deliveries: readonly UwDeliveryFacts[], uw: Scope): UwDeliveryFacts | null {
  const matches = deliveries.filter((item) => equalScope(item.uw, uw))
  const [match] = matches
  return matches.length === 1 && match !== undefined ? match : null
}
