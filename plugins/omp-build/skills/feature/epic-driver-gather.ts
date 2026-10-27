import { type NativeEpicPullRequest, readNativeEpicChildren } from '../../adapters/github-native/epic-children.ts'
import type { DecodedHistory } from '../../dist/contracts.js'
import { type CanonicalEpic, issueNumber, readCanonicalEpic } from './epic-driver-canonical'
import {
  baseCi,
  branchRefs,
  issueHistory,
  prFacts,
  pullRequestsForChild,
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
import { git, graphql, Refused } from './epic-driver-runtime'
import type { BranchFacts, ChildFacts, Facts, OwnUwObservation } from './epic-types'
import { readLanding } from './workflow-readiness.js'

type ChildHistory = DecodedHistory
type ChildHistoryEntry = [number, ChildHistory]

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
  node: CanonicalEpic['nodes'][number],
  full: string,
  native: CanonicalEpic['native'],
  history: ChildHistory,
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUw: OwnUwObservation,
): ChildFacts {
  const number = issueNumber(node.uw)
  const body = node.raw.body
  if (/<!--\s*omp-build:epic-fix\b/.test(body)) {
    throw new Refused(`#${number} has a legacy epic-fix body marker; publish a canonical epic-event instead`)
  }
  return {
    number,
    title: node.title,
    state: node.native.state,
    stateReason: node.native.stateReason,
    labels: [...node.labels],
    body,
    ownUw,
    epicFix: hasEpicFixEvent(history),
    blockedBy: node.blockers.map((scope) => {
      const blocker = native.get(`${scope.repository}\0${scope.target}`)
      if (blocker === undefined) throw new Refused(`native blocker ${scope.target} was not observed`)
      return {
        number: issueNumber(scope),
        state: blocker.native.state,
        stateReason: blocker.native.stateReason,
        ...(scope.repository === full ? {} : { repo: scope.repository }),
      }
    }),
    stops: stopsFromEvents(history),
    prs: (rawPrs.get(number) ?? []).map((pr) => prFacts(pr, stopped)),
    branches: refs.get(number) ?? [],
  }
}

function observedChildren(
  nodes: readonly CanonicalEpic['nodes'][number][],
  full: string,
  native: CanonicalEpic['native'],
  histories: Map<number, ChildHistory>,
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUws: Map<number, OwnUwObservation>,
): ChildFacts[] {
  return nodes.map((node) => {
    const number = issueNumber(node.uw)
    const history = histories.get(number)
    if (history === undefined) throw new Error(`missing history for #${number}`)
    const ownUw = ownUws.get(number)
    if (ownUw === undefined) throw new Error(`missing own UW observation for #${number}`)
    return observedChild(node, full, native, history, rawPrs, stopped, refs, ownUw)
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
  const canonical = await readCanonicalEpic(repo, epic, full)
  const { native, nodes, ownUws, parentAdmission } = canonical
  // The legacy child query remains PR discovery only. Canonical graph facts above
  // are the sole source for membership, state, labels, and blocker relations.
  const graph = <T>(query: string, variables: Record<string, string | number>): T => graphql<T>(repo, query, variables)
  const legacy = readNativeEpicChildren(owner, name, epic, full, graph, (message) => {
    throw new Refused(message)
  })
  const rawPrs = new Map(
    nodes.map((node) => {
      const number = issueNumber(node.uw)
      const legacyChild = legacy.find((child) => child.number === number)
      return [number, legacyChild === undefined ? [] : pullRequestsForChild(legacyChild, full)]
    }),
  )
  const open = [
    ...new Set(
      [...rawPrs.values()]
        .flat()
        .filter((pr) => pr.state === 'OPEN')
        .map((pr) => pr.number),
    ),
  ]
  const stopped = reviews ? await stoppedReviews(repo, full, open) : new Set<number>()
  const numbers = nodes.map((node) => issueNumber(node.uw))
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
    children: observedChildren(nodes, full, native, histories, rawPrs, stopped, refs, ownUws),
    reviews: reviewsFromEvents(epicHistory),
    hooks: hooksFromEvents(epicHistory),
  }
  return { facts, epicHistory, parentAdmission }
}
