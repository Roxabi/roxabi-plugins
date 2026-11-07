import { canonicalValueDigest } from '../engine/action-input.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

type DeliveryGit = {
  commits: Map<string, NativeWorldFacts['commits'][number]>
  comparisons: Map<string, NativeWorldFacts['comparisons'][number]>
}

function nativeCommit(
  sha: string,
  initialCommits: NativeWorldFacts['commits'] | undefined,
  delivery: DeliveryGit | null,
): string {
  const initial = initialCommits?.find((item) => item.sha === sha)
  const later = delivery?.commits.get(sha)
  if (initial && later && canonicalValueDigest(initial) !== canonicalValueDigest(later))
    throw new Error(`Conflicting native commit ${sha}`)
  const commit = later ?? initial
  if (!commit) throw new Error(`Undeclared native commit ${sha}`)
  return JSON.stringify({ sha: commit.sha, parents: commit.parents.map((parent) => ({ sha: parent })) })
}

function initialComparison(match: RegExpExecArray, commits: NativeWorldFacts['commits']): string {
  const first = commits.find((item) => item.sha === match[1])
  const last = commits.find((item) => item.sha === match[2])
  if (!first || !last) throw new Error('Undeclared native comparison endpoints')
  if (first.sha === last.sha) return JSON.stringify({ status: 'identical', total_commits: 0, commits: [] })
  if (last.parents.length !== 1 || last.parents[0] !== first.sha)
    throw new Error('Native comparison range was not fully declared')
  const items = Number(match[3]) === 1 ? [{ sha: last.sha, parents: [{ sha: first.sha }] }] : []
  return JSON.stringify({ status: 'ahead', total_commits: 1, commits: items })
}

export function sisterNativeGitRequest(
  endpoint: string,
  initialCommits: NativeWorldFacts['commits'] | undefined,
  delivery: DeliveryGit | null,
): string | null {
  const commitMatch = /^repos\/acme\/app\/git\/commits\/([a-f0-9]{40})$/.exec(endpoint)
  if (commitMatch) {
    const sha = commitMatch[1]
    if (sha === undefined) throw new Error('Undeclared native commit')
    return nativeCommit(sha, initialCommits, delivery)
  }
  const comparisonMatch =
    /^repos\/acme\/app\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(endpoint)
  if (comparisonMatch && !delivery && initialCommits) return initialComparison(comparisonMatch, initialCommits)
  if (comparisonMatch && delivery) {
    const comparison = delivery.comparisons.get(`${comparisonMatch[1]}\0${comparisonMatch[2]}`)
    if (!comparison) throw new Error('Undeclared native comparison')
    const offset = (Number(comparisonMatch[3]) - 1) * 100
    const commits = comparison.commits.slice(offset, offset + 100).map((sha) => {
      const item = delivery.commits.get(sha)
      if (!item) throw new Error(`Undeclared native commit ${sha}`)
      return { sha, parents: item.parents.map((parent) => ({ sha: parent })) }
    })
    return JSON.stringify({ status: comparison.status, total_commits: comparison.commits.length, commits })
  }
  return null
}
