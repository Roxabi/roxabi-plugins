import { existsSync, realpathSync } from 'node:fs'
import type { NativeEpicChild, NativeEpicPullRequest } from '../../adapters/github-native/epic-children.ts'
import { type DecodedHistory, decodeHistory, githubScope, readGitHubHistory } from '../../dist/contracts.js'
import { summarizeReviews } from '../../engine/review-state.ts'
import { mandateParentHistories } from '../../roxabi/feature-context.ts'
import { loadContracts } from '../../roxabi/feature-engine.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { loadReviewConfig } from '../../roxabi/review-assets.ts'
import { readReviewInputHistories } from '../../roxabi/uw-input-readers.ts'
import { type CheckNode, classifyBaseCi } from './epic-ci'
import { refuseForeignCommits, ticketOfBranch, ticketOfSubject } from './epic-claims'
import { readHistoryPairs } from './epic-driver-history-pairs'
import { gh, ghHistory, git, graphql, Refused } from './epic-driver-runtime'
import type { BaseCi, BranchFacts, Facts, PrFacts } from './epic-types'

type RollupData = {
  repository: { object: { statusCheckRollup: { contexts: { nodes: CheckNode[] } } | null } | null }
}

export function isPr(value: Partial<NativeEpicPullRequest> | null | undefined): value is NativeEpicPullRequest {
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
    value.labels !== null &&
    Array.isArray(value.labels.nodes) &&
    value.labels.nodes.every(
      (label) => label !== null && typeof label === 'object' && typeof label.name === 'string',
    ) &&
    value.mergeCommit !== undefined &&
    value.autoMergeRequest !== undefined &&
    value.mergedAt !== undefined
  )
}

export function pullRequestsForChild(child: NativeEpicChild, full: string): NativeEpicPullRequest[] {
  const found = new Map<number, NativeEpicPullRequest>()
  const sources = [...child.closedByPullRequests, ...child.timelinePullRequestSources.map((item) => item?.source)]
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

const adapterGhByRepo = new Map<string, (cwd: string, args: string[]) => Promise<string>>()
let adapterViewerLogin: string | undefined

export function adapterOptions(repo: string) {
  let transport = adapterGhByRepo.get(repo)
  if (transport === undefined) {
    transport = async (cwd: string, args: string[]) => gh(cwd, args)
    adapterGhByRepo.set(repo, transport)
  }
  if (adapterViewerLogin === undefined) {
    const login = gh(repo, ['api', 'user', '--jq', '.login']).trim()
    if (!login || /\s/.test(login)) throw new Error('gh api user returned no login')
    adapterViewerLogin = login
  }
  return withRoxabiGitHubPolicy({
    cwd: repo,
    gh: transport,
    automationLogin: adapterViewerLogin,
    writerLogin: adapterViewerLogin,
  })
}

export async function issueHistory(repo: string, repository: string, issue: number): Promise<DecodedHistory> {
  return decodeHistory(
    await readGitHubHistory(githubScope(repository, issue), { ...adapterOptions(repo), gh: ghHistory }),
  )
}

export async function parentMandateHistories(repo: string, history: DecodedHistory): Promise<DecodedHistory[]> {
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Refused(`engine-unavailable:${loaded.missing}`)
  const result = await mandateParentHistories(loaded, history, adapterOptions(repo))
  if (!result.ok) throw new Refused(result.reason)
  return result.parents
}

export function diagnosticsText(diagnostics: readonly { code: string; message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
}

/** External histories only. Same-scope identity stays on the caller root. */
export async function citedReviewHistories(repo: string, history: DecodedHistory): Promise<readonly DecodedHistory[]> {
  const options = adapterOptions(repo)
  if (options.gh === undefined) throw new Refused('cited review history is not readable: github transport is absent')
  const cited = await readReviewInputHistories(history, {
    cwd: options.cwd,
    gh: options.gh,
    readAuthor: options.readAuthor ?? options.automationLogin,
  })
  if (!cited.ok) throw new Refused(`cited review history is not readable: ${diagnosticsText(cited.diagnostics)}`)
  return cited.value
}

/** The canonical review graph is the only source of review-bound disposition. */
export async function stoppedReviews(repo: string, repository: string, numbers: number[]): Promise<Set<number>> {
  const taxonomy = loadReviewConfig().canonicalClasses
  const states = await readHistoryPairs(numbers, async (number) => {
    const history = await issueHistory(repo, repository, number)
    const summary = summarizeReviews(history, taxonomy, null, await citedReviewHistories(repo, history))
    if (!summary.ok)
      throw new Refused(`PR #${number} review history is not admissible: ${diagnosticsText(summary.diagnostics)}`)
    return summary.value.spent ? number : null
  })
  return new Set(states.filter((number): number is number => number !== null))
}

export function prFacts(raw: NativeEpicPullRequest, stopped: Set<number>): PrFacts {
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
