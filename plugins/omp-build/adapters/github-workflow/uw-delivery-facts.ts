import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import type { UwDeliveryFacts } from '../../engine/uw-completion-types.ts'
import type { GitHubOptions } from '../github/types.ts'
import { collectDeliveryCandidates } from './uw-delivery-candidates.ts'
import { type CommitRead, createCommitRangeReader } from './uw-delivery-commit-ranges.ts'
import { type Enumeration, enumeratePullRequests } from './uw-delivery-enumeration.ts'
import { collectDeliveryIntegrations } from './uw-delivery-integrations.ts'

type ObservedCommit = UwDeliveryFacts['commits'][number]
type DeliveryFailure = {
  ok: false
  diagnostics: Diagnostic[]
  partial: { facts: UwDeliveryFacts; histories: readonly DecodedHistory[] }
}

function loadHistories(histories: readonly DecodedHistory[], loaded: Map<string, DecodedHistory>): Diagnostic[] | null {
  for (const history of histories) {
    const scope = history.source.scope
    const key = `${scope.repository}\0${scope.target}`
    const previous = loaded.get(key)
    if (previous && previous !== history && JSON.stringify(previous) !== JSON.stringify(history))
      return [{ code: 'conflicting-history', message: `Conflicting history for ${scope.repository} ${scope.target}` }]
    loaded.set(key, history)
  }
  return null
}

function appendCommits(observed: ObservedCommit[], seen: Set<string>, commits: readonly ObservedCommit[]): void {
  for (const commit of commits) {
    if (!seen.has(commit.code.commit)) {
      seen.add(commit.code.commit)
      observed.push(commit)
    }
  }
}

type AncestryInput = {
  uw: Scope
  head: ObservedCommit['code']
  ancestors: readonly ObservedCommit['code'][]
}

type RangeReader = (
  uw: Scope,
  ranges: readonly { base: string; head: string }[],
  heads: readonly string[],
  strict: boolean,
) => Promise<CommitRead>

async function readAncestry(
  input: AncestryInput,
  ancestryReads: Map<string, Promise<CommitRead>>,
  readCommitRanges: RangeReader,
): Promise<CommitRead> {
  const observed: ObservedCommit[] = []
  const seen = new Set<string>()
  if (
    input.head.repository !== input.uw.repository ||
    input.ancestors.some((item) => item.repository !== input.uw.repository)
  )
    return {
      ok: false,
      diagnostics: [{ code: 'incomplete', message: 'Ancestry endpoints must belong to the parent repository' }],
      partial: observed,
    }
  for (const ancestor of input.ancestors) {
    const key = `${input.uw.repository}\0${ancestor.commit}\0${input.head.commit}`
    let pending = ancestryReads.get(key)
    if (pending === undefined) {
      pending = readCommitRanges(input.uw, [{ base: ancestor.commit, head: input.head.commit }], [], false)
      ancestryReads.set(key, pending)
    }
    const result = await pending
    appendCommits(observed, seen, result.ok ? result.value : result.partial)
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics, partial: observed }
  }
  return { ok: true, value: observed }
}

function readEnumeration(
  uw: Scope,
  options: GitHubOptions,
  repositories: Map<string, Promise<Enumeration>>,
): Promise<Enumeration> {
  const repositoryKey = uw.repository.toLowerCase()
  let enumeration = repositories.get(repositoryKey)
  if (enumeration === undefined) {
    enumeration = enumeratePullRequests(uw.repository, options)
    repositories.set(repositoryKey, enumeration)
  }
  return enumeration
}

function enumerationResult(candidates: Enumeration) {
  if (candidates.ok) return { diagnostics: [], values: candidates.value }
  return { diagnostics: candidates.diagnostics, values: 'partial' in candidates ? candidates.partial : [] }
}

/** Observation-local; create a new reader after native effects. */
export function createUwDeliveryFactReader(options: GitHubOptions) {
  const repositories = new Map<string, Promise<Enumeration>>()
  const loaded = new Map<string, DecodedHistory>()
  const readCommitRanges = createCommitRangeReader(options)
  const ancestryReads = new Map<string, Promise<CommitRead>>()

  async function read(
    uw: Scope,
    histories: readonly DecodedHistory[],
  ): Promise<{ ok: true; value: { facts: UwDeliveryFacts; histories: readonly DecodedHistory[] } } | DeliveryFailure> {
    const kept: DecodedHistory[] = []
    const pulls: UwDeliveryFacts['pullRequests'][number][] = []
    const integrations: UwDeliveryFacts['integrations'][number][] = []
    const observed: ObservedCommit[] = []
    let enumerationDiagnostics: Diagnostic[] = []
    const failure = (diagnostics: Diagnostic[]): DeliveryFailure => ({
      ok: false,
      diagnostics: [...enumerationDiagnostics, ...diagnostics],
      partial: { facts: { uw, pullRequests: pulls, integrations, commits: observed }, histories: kept },
    })
    const conflict = loadHistories(histories, loaded)
    if (conflict !== null) return failure(conflict)
    const candidates = enumerationResult(await readEnumeration(uw, options, repositories))
    enumerationDiagnostics = candidates.diagnostics
    const collected = await collectDeliveryCandidates(candidates.values, uw, options, loaded, kept, pulls)
    if (!collected.ok) return failure(collected.diagnostics)
    const all = [...histories, ...kept.filter((history) => !histories.includes(history))]
    const ranges = collectDeliveryIntegrations(uw, all, pulls, integrations)
    const commitRead = await readCommitRanges(
      uw,
      [...ranges.values()],
      pulls.flatMap((pull) => (pull.mergeCommit === null ? [] : [pull.mergeCommit])),
      true,
    )
    observed.push(...(commitRead.ok ? commitRead.value : commitRead.partial))
    if (!commitRead.ok) return failure(commitRead.diagnostics)
    if (enumerationDiagnostics.length) return failure([])
    return { ok: true, value: { facts: { uw, pullRequests: pulls, integrations, commits: observed }, histories: kept } }
  }
  return { read, readAncestry: (input: AncestryInput) => readAncestry(input, ancestryReads, readCommitRanges) }
}
