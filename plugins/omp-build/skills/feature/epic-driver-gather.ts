import type { DecodedHistory } from '../../dist/contracts.js'
import {
  baseCi,
  branchRefs,
  epicChildren,
  issueHistory,
  prFacts,
  pullRequestsForChild,
  type RawChild,
  type RawPr,
  repoName,
  stoppedReviews,
  tree,
} from './epic-driver-github'
import {
  type Gathered,
  hasEpicFixEvent,
  hooksFromEvents,
  reviewsFromEvents,
  stopsFromEvents,
} from './epic-driver-history'
import { git, Refused } from './epic-driver-runtime'
import type { BranchFacts, ChildFacts, Facts } from './epic-types'
import { readLanding } from './workflow-readiness.js'

type EpicChild = RawChild
type ChildHistory = DecodedHistory
type ChildHistoryEntry = [number, ChildHistory]

function ensureLocalChildren(nodes: readonly EpicChild[], full: string): void {
  const elsewhere = nodes.filter((node) => node.repository.nameWithOwner !== full)
  if (elsewhere.length === 0) return
  const names = elsewhere.map((node) => `${node.repository.nameWithOwner}#${node.number}`).join(', ')
  throw new Refused(`the Epic run delivers only ${full}; sub-issues elsewhere: ${names}`)
}

async function historyEntry(repo: string, full: string, number: number): Promise<ChildHistoryEntry> {
  return [number, await issueHistory(repo, full, number)]
}

async function historiesFor(repo: string, full: string, epic: number, numbers: number[]) {
  const [epicHistory, childHistories] = await Promise.all([
    issueHistory(repo, full, epic),
    Promise.all(numbers.map((number) => historyEntry(repo, full, number))),
  ])
  return { epicHistory, histories: new Map(childHistories) }
}

function observedChild(
  node: EpicChild,
  full: string,
  history: ChildHistory,
  rawPrs: Map<number, RawPr[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
): ChildFacts {
  const body = node.body ?? ''
  if (/<!--\s*omp-build:epic-fix\b/.test(body)) {
    throw new Refused(`#${node.number} has a legacy epic-fix body marker; publish a canonical epic-event instead`)
  }
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    labels: node.labels.nodes.map((label) => label.name),
    body,
    epicFix: hasEpicFixEvent(history),
    blockedBy: node.blockedBy.nodes.map((blocker) =>
      blocker.repository.nameWithOwner === full
        ? { number: blocker.number, state: blocker.state }
        : { number: blocker.number, state: blocker.state, repo: blocker.repository.nameWithOwner },
    ),
    stops: stopsFromEvents(history),
    prs: (rawPrs.get(node.number) ?? []).map((pr) => prFacts(pr, stopped)),
    branches: refs.get(node.number) ?? [],
  }
}

function observedChildren(
  nodes: readonly EpicChild[],
  full: string,
  histories: Map<number, ChildHistory>,
  rawPrs: Map<number, RawPr[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
): ChildFacts[] {
  return nodes.map((node) => {
    const history = histories.get(node.number)
    if (history === undefined) throw new Error(`missing history for #${node.number}`)
    return observedChild(node, full, history, rawPrs, stopped, refs)
  })
}

function landingObservation(repo: string, base: string, dashboard: boolean) {
  if (!dashboard) return { landing: null, landingError: null }
  try {
    return { landing: readLanding(repo, { base }), landingError: null }
  } catch (error) {
    return { landing: null, landingError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Everything `nextStep` reads. `git: false` leaves the worktree out (for
 * `objective`, which may run anywhere); `run` and `base` come from the gate.
 */
export async function gather(
  repo: string,
  epic: number,
  run: string,
  base: string,
  { git: withGit = true, dashboard = true, reviews = true } = {},
): Promise<Gathered> {
  const { owner, name, full } = repoName(repo)
  const nodes = epicChildren(repo, owner, name, epic, full)
  ensureLocalChildren(nodes, full)
  const rawPrs = new Map(nodes.map((node) => [node.number, pullRequestsForChild(node, full)]))
  const open = [
    ...new Set(
      [...rawPrs.values()]
        .flat()
        .filter((pr) => pr.state === 'OPEN')
        .map((pr) => pr.number),
    ),
  ]
  const stopped = reviews ? await stoppedReviews(repo, full, open) : new Set<number>()
  const numbers = nodes.map((node) => node.number)
  const { epicHistory, histories } = await historiesFor(repo, full, epic, numbers)
  const refs = withGit ? branchRefs(repo, base, numbers) : new Map<number, BranchFacts[]>()
  const baseSha = withGit ? git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) : ''
  const { landing, landingError } = landingObservation(repo, base, dashboard)
  const facts: Facts = {
    epic,
    run,
    base,
    baseSha,
    tree: withGit ? tree(repo) : { clean: true, branch: null },
    baseCi: !dashboard
      ? { state: 'unread', failed: [], pending: [] }
      : withGit && landing
        ? baseCi(repo, owner, name, baseSha, landing.required_checks)
        : { state: 'none', failed: [], pending: [] },
    landingError,
    children: observedChildren(nodes, full, histories, rawPrs, stopped, refs),
    reviews: reviewsFromEvents(epicHistory),
    hooks: hooksFromEvents(epicHistory),
  }
  return { facts, epicHistory }
}
