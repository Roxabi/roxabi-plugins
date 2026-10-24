import { existsSync, realpathSync } from 'node:fs'
import {
  type DecodedHistory,
  decodeHistory,
  githubScope,
  readGitHubHistory,
  summarizeReviews,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { loadReviewConfig } from '../../roxabi/review-config.ts'
import { type CheckNode, classifyBaseCi } from './epic-ci'
import { refuseForeignCommits, ticketOfBranch, ticketOfSubject } from './epic-claims'
import { gh, git, graphql, Refused } from './epic-driver-runtime'
import type { BaseCi, BranchFacts, Facts, PrFacts } from './epic-types'

// ── GitHub shapes selected below ─────────────────────────────────────────────

export type RawPr = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefName: string
  headRefOid: string
  mergedAt: string | null
  mergeCommit: { oid: string; parents: { nodes: { oid: string }[] } } | null
  autoMergeRequest: { enabledAt: string } | null
  labels: { nodes: { name: string }[] }
  repository: { nameWithOwner: string }
  /** A fork PR: its head lives outside this repository, so no local ref proves what it lands. */
  isCrossRepository: boolean
}

function isPr(value: Partial<RawPr> | null | undefined): value is RawPr {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.number === 'number' &&
    (value.state === 'OPEN' || value.state === 'CLOSED' || value.state === 'MERGED') &&
    typeof value.baseRefName === 'string' &&
    typeof value.headRefName === 'string' &&
    typeof value.headRefOid === 'string' &&
    value.repository !== undefined &&
    typeof value.repository.nameWithOwner === 'string' &&
    typeof value.isCrossRepository === 'boolean' &&
    value.labels !== undefined &&
    Array.isArray(value.labels.nodes) &&
    value.mergeCommit !== undefined &&
    value.autoMergeRequest !== undefined &&
    value.mergedAt !== undefined
  )
}
export type RawChild = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  body: string | null
  repository: { nameWithOwner: string }
  labels: { nodes: { name: string }[] }
  blockedBy: { nodes: { number: number; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[] }
  closedByPullRequestsReferences: { nodes: RawPr[] }
  timelineItems: { nodes: ({ source?: Partial<RawPr> | null } | null)[] }
}
type EpicData = {
  repository: {
    issue: {
      subIssues: { pageInfo: { hasNextPage: boolean }; nodes: RawChild[] }
    } | null
  }
}
type RollupData = {
  repository: { object: { statusCheckRollup: { contexts: { nodes: CheckNode[] } } | null } | null }
}

const PR_FIELDS = `number state baseRefName headRefName headRefOid mergedAt isCrossRepository
  mergeCommit { oid parents(first: 1) { nodes { oid } } }
  autoMergeRequest { enabledAt } labels(first: 30) { nodes { name } } repository { nameWithOwner }`

const EPIC_QUERY = `query($owner: String!, $name: String!, $epic: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $epic) {
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          number title state body repository { nameWithOwner }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
            nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } } }
          }
        }
      }
    }
  }
}`

export function epicChildren(repo: string, owner: string, name: string, epic: number, full: string): RawChild[] {
  const issue = graphql<EpicData>(repo, EPIC_QUERY, { owner, name, epic }).repository.issue
  if (!issue) throw new Refused(`#${epic} does not exist in ${full}`)
  if (issue.subIssues.pageInfo.hasNextPage) throw new Refused(`#${epic} has more than 100 sub-issues`)
  return issue.subIssues.nodes
}

export function pullRequestsForChild(child: RawChild, full: string): RawPr[] {
  const found = new Map<number, RawPr>()
  const sources = [
    ...child.closedByPullRequestsReferences.nodes,
    ...child.timelineItems.nodes.map((item) => item?.source),
  ]
  for (const pr of sources) {
    if (
      isPr(pr) &&
      pr.repository.nameWithOwner === full &&
      !pr.isCrossRepository &&
      ticketOfBranch(pr.headRefName) === child.number
    ) {
      found.set(pr.number, pr)
    }
  }
  return [...found.values()]
}

// ── Facts ────────────────────────────────────────────────────────────────────

export function repoName(repo: string): { owner: string; name: string; full: string } {
  const full = gh(repo, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Error(`cannot read the repository name: ${full}`)
  return { owner, name, full }
}

export function adapterOptions(repo: string) {
  return withRoxabiGitHubPolicy({ cwd: repo, gh: async (cwd: string, args: string[]) => gh(cwd, args) })
}

export async function issueHistory(repo: string, repository: string, issue: number): Promise<DecodedHistory> {
  return decodeHistory(await readGitHubHistory(githubScope(repository, issue), adapterOptions(repo)))
}

export async function historyFor(repo: string, scope: { repository: string; target: string }): Promise<DecodedHistory> {
  return decodeHistory(await readGitHubHistory(scope, adapterOptions(repo)))
}

export function diagnosticsText(diagnostics: readonly { code: string; message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
}

/** The canonical review graph is the only source of review-bound disposition. */
export async function stoppedReviews(repo: string, repository: string, numbers: number[]): Promise<Set<number>> {
  const taxonomy = loadReviewConfig().canonicalClasses
  const states = await Promise.all(
    numbers.map(async (number) => {
      const summary = summarizeReviews(await issueHistory(repo, repository, number), taxonomy, null)
      if (!summary.ok)
        throw new Refused(`PR #${number} review history is not admissible: ${diagnosticsText(summary.diagnostics)}`)
      return summary.value.spent ? number : null
    }),
  )
  return new Set(states.filter((number): number is number => number !== null))
}

export function prFacts(raw: RawPr, stopped: Set<number>): PrFacts {
  const labels = raw.labels.nodes.map((label) => label.name)
  return {
    number: raw.number,
    state: raw.state,
    base: raw.baseRefName,
    head: raw.headRefName,
    headSha: raw.headRefOid,
    mergedAt: raw.mergedAt,
    mergeSha: raw.mergeCommit?.oid ?? null,
    baseSha: raw.mergeCommit?.parents.nodes[0]?.oid ?? null,
    armed: labels.includes('reviewed') || raw.autoMergeRequest !== null,
    exhausted: stopped.has(raw.number),
  }
}

export function tree(repo: string): Facts['tree'] {
  return {
    clean: git(repo, ['status', '--porcelain']) === '',
    branch: git(repo, ['branch', '--show-current']) || null,
  }
}

function worktreeHolders(repo: string): Map<string, string> {
  const holders = new Map<string, string>()
  let path = ''
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/')) holders.set(line.slice('branch refs/heads/'.length), path)
  }
  return holders
}

type BranchTips = { local: string | null; remote: string | null }

function branchTips(repo: string, children: number[]): Map<string, BranchTips> {
  const byName = new Map<string, BranchTips>()
  const refs = git(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin'])
  for (const line of refs.split('\n')) {
    const [ref, sha] = line.split('\t')
    if (!ref || !sha) continue
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '')
    const ticket = ticketOfBranch(name)
    if (ticket === null || !children.includes(ticket)) continue
    const tips = byName.get(name) ?? { local: null, remote: null }
    if (ref.startsWith('refs/heads/')) tips.local = sha
    else tips.remote = sha
    byName.set(name, tips)
  }
  return byName
}

function branchCommits(repo: string, base: string, local: string | null, remote: string | null) {
  return [...new Set([local, remote].filter((sha): sha is string => sha !== null))].flatMap((sha) =>
    git(repo, ['log', '--no-merges', '--format=%H%x09%s', `refs/remotes/origin/${base}..${sha}`])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('\t')
        return { sha: line.slice(0, at), ticket: ticketOfSubject(line.slice(at + 1)) }
      }),
  )
}

function branchFact(
  repo: string,
  base: string,
  here: string,
  holders: Map<string, string>,
  name: string,
  ticket: number,
  { local, remote }: BranchTips,
): BranchFacts {
  const verdict = refuseForeignCommits(branchCommits(repo, base, local, remote), ticket)
  const holder = holders.get(name)
  return {
    name,
    local: local !== null,
    tip: local ?? remote ?? '',
    remoteTip: remote,
    foreign: 'error' in verdict ? verdict.error.replace(/^foreign commit /, '') : null,
    elsewhere: holder && (!existsSync(holder) || realpathSync(holder) !== here) ? holder : null,
  }
}

/** Local and origin branches claiming each child, deduped by name, with their foreign commits. */
export function branchRefs(repo: string, base: string, children: number[]): Map<number, BranchFacts[]> {
  const here = realpathSync(git(repo, ['rev-parse', '--show-toplevel']))
  const holders = worktreeHolders(repo)
  const out = new Map<number, BranchFacts[]>()
  for (const [name, tips] of branchTips(repo, children)) {
    const ticket = ticketOfBranch(name)
    if (ticket === null) continue
    const facts = out.get(ticket)
    const fact = branchFact(repo, base, here, holders, name, ticket, tips)
    if (facts) facts.push(fact)
    else out.set(ticket, [fact])
  }
  return out
}

/** The base HEAD's check rollup, reduced by `classifyBaseCi` with the landing's check set. */
export function baseCi(repo: string, owner: string, name: string, sha: string, required: string[]): BaseCi {
  const data = graphql<RollupData>(
    repo,
    `query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) {
      object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state }
      } } } } } } }`,
    { owner, name, sha },
  )
  return classifyBaseCi(data.repository.object?.statusCheckRollup?.contexts.nodes ?? [], required)
}
