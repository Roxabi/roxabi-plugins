import {
  type NativeEpicChild,
  type NativeEpicPullRequest,
  readNativeEpicChildren,
} from '../../adapters/github-native/epic-children.ts'
import { type DecodedHistory, sameScope } from '../../dist/contracts.js'
import type { SpecSnapshot } from '../../engine/uw-spec.ts'
import type { UwRead, UwReadPort } from '../../roxabi/uw-contract.ts'
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
import { git, graphql, Refused, uwReadPort } from './epic-driver-runtime'
import type { BranchFacts, ChildFacts, Facts, OwnUwObservation } from './epic-types'
import { readLanding } from './workflow-readiness.js'

type EpicChild = NativeEpicChild
type ChildHistory = DecodedHistory
type ChildHistoryEntry = [number, ChildHistory]
type OwnUwDiagnostic = Extract<OwnUwObservation, { status: 'refused' }>['diagnostics'][number]
type OwnUwIdentityAllocations = Extract<OwnUwObservation, { status: 'framed' }>['identityAllocations']
type OwnUwRead = UwRead
type OwnUwTier = Extract<OwnUwObservation, { status: 'framed' }>['tier']

function diagnostic(uw: { repository: string; target: string }, code: string, message: string): OwnUwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function childCommitmentsMatch(
  nativeChildren: readonly { repository: string; target: string }[],
  acceptedChildren: readonly { scope: { repository: string; target: string } }[],
): boolean {
  return (
    nativeChildren.length === acceptedChildren.length &&
    nativeChildren.every((child) => acceptedChildren.some((accepted) => sameScope(child, accepted.scope)))
  )
}

function observationDiagnostics(read: OwnUwRead): OwnUwDiagnostic[] {
  return [
    ...(read.graph.status === 'incomplete' ? read.graph.diagnostics : []),
    ...(read.proposed.ok ? [] : read.proposed.diagnostics),
    ...(read.accepted.status === 'refused' ? read.accepted.diagnostics : []),
    ...(read.identity.ok ? [] : read.identity.diagnostics),
    ...read.admission.framed.diagnostics,
  ]
}

function identityAllocations(read: OwnUwRead): OwnUwIdentityAllocations {
  return read.identity.ok
    ? [...read.identity.value.allocations].map(([id, allocation]) => ({ id, allocationRef: allocation }))
    : []
}

function tierOf(labels: readonly string[]): OwnUwTier | null {
  const label = labels.find((item) => item === 'size:S' || item === 'size:F-lite' || item === 'size:F-full')
  if (label === 'size:S') return 'S'
  if (label === 'size:F-lite') return 'F-lite'
  if (label === 'size:F-full') return 'F-full'
  return null
}

function acceptedOwnSpec(
  read: OwnUwRead,
  current: SpecSnapshot,
  uw: { repository: string; target: string },
  nativeChildren: readonly { repository: string; target: string }[],
  tier: OwnUwTier,
  diagnostics: OwnUwDiagnostic[],
) {
  if (read.accepted.status !== 'accepted') return null
  if (!sameScope(read.accepted.value.ref.uw, uw))
    diagnostics.push(diagnostic(uw, 'unsettled-child', 'Accepted own Spec belongs to another UW'))
  if (current.spec.version !== read.accepted.value.snapshot.spec.version)
    diagnostics.push(diagnostic(uw, 'material-change-pending', 'Current child Spec differs from its accepted snapshot'))
  if (tier !== read.accepted.value.tier)
    diagnostics.push(diagnostic(uw, 'material-change-pending', 'Current child tier differs from its accepted tier'))
  if (!childCommitmentsMatch(nativeChildren, read.accepted.value.children))
    diagnostics.push(
      diagnostic(uw, 'material-change-pending', 'Current child commitments differ from accepted child commitments'),
    )
  return diagnostics.length === 0 ? read.accepted.value : null
}

function settledOwnUw(
  read: OwnUwRead,
  uw: { repository: string; target: string },
  diagnostics: OwnUwDiagnostic[],
  allocations: OwnUwIdentityAllocations,
): OwnUwObservation | null {
  const proposed = read.proposed
  if (diagnostics.length !== 0 || !proposed.ok || !read.identity.ok || read.graph.status !== 'complete') return null
  const root = read.graph.nodes.find((node) => sameScope(node.uw, uw))
  if (root === undefined) {
    diagnostics.push(diagnostic(uw, 'graph-incomplete', 'Own UW root was not observed'))
    return null
  }
  const tier = tierOf(root.labels)
  if (tier === null) {
    diagnostics.push(diagnostic(uw, 'tier-missing', 'Own UW has no native tier'))
    return null
  }
  if (read.accepted.status === 'absent')
    return {
      status: 'framed',
      snapshot: proposed.snapshot,
      tier,
      graphComplete: true,
      identityAllocations: allocations,
    }
  const accepted = acceptedOwnSpec(read, proposed.snapshot, uw, root.children, tier, diagnostics)
  return accepted === null
    ? null
    : { status: 'accepted', accepted, graphComplete: true, identityAllocations: allocations }
}

function refusalObservation(diagnostics: OwnUwDiagnostic[]): Extract<OwnUwObservation, { status: 'refused' }> {
  const reason = diagnostics.some((entry) => entry.code === 'graph-incomplete')
    ? 'incomplete'
    : diagnostics.some((entry) => entry.code === 'material-change-pending')
      ? 'changed-child'
      : 'unsettled'
  return { status: 'refused', reason, diagnostics }
}

async function observeOwnUw(
  readUw: UwReadPort['readUw'],
  uw: { repository: string; target: string },
): Promise<OwnUwObservation> {
  try {
    const read = await readUw(uw)
    const diagnostics = observationDiagnostics(read)
    const allocations = identityAllocations(read)
    return settledOwnUw(read, uw, diagnostics, allocations) ?? refusalObservation(diagnostics)
  } catch (error) {
    return {
      status: 'refused',
      reason: 'incomplete',
      diagnostics: [diagnostic(uw, 'graph-incomplete', error instanceof Error ? error.message : String(error))],
    }
  }
}

function ensureLocalChildren(nodes: readonly EpicChild[], full: string): void {
  const elsewhere = nodes.filter((node) => node.repository !== full)
  if (elsewhere.length === 0) return
  const names = elsewhere.map((node) => `${node.repository}#${node.number}`).join(', ')
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
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUw: OwnUwObservation,
): ChildFacts {
  const body = node.body ?? ''
  if (/<!--\s*omp-build:epic-fix\b/.test(body)) {
    throw new Refused(`#${node.number} has a legacy epic-fix body marker; publish a canonical epic-event instead`)
  }
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    labels: node.labels,
    body,
    ownUw,
    epicFix: hasEpicFixEvent(history),
    blockedBy: node.blockedBy.map((blocker) =>
      blocker.repository === full
        ? { number: blocker.number, state: blocker.state }
        : { number: blocker.number, state: blocker.state, repo: blocker.repository },
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
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUws: Map<number, OwnUwObservation>,
): ChildFacts[] {
  return nodes.map((node) => {
    const history = histories.get(node.number)
    if (history === undefined) throw new Error(`missing history for #${node.number}`)
    const ownUw = ownUws.get(node.number)
    if (ownUw === undefined) throw new Error(`missing own UW observation for #${node.number}`)
    return observedChild(node, full, history, rawPrs, stopped, refs, ownUw)
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
  const graph = <T>(query: string, variables: Record<string, string | number>): T => graphql<T>(repo, query, variables)
  const nodes = readNativeEpicChildren(owner, name, epic, full, graph, (message) => {
    throw new Refused(message)
  })
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
  const reader = await uwReadPort(repo)
  const [{ epicHistory, histories }, ownUws] = await Promise.all([
    historiesFor(repo, full, epic, numbers),
    Promise.all(
      nodes.map(
        async (node) =>
          [
            node.number,
            await observeOwnUw(reader.readUw, { repository: full, target: `${full}#${node.number}` }),
          ] as const,
      ),
    ),
  ])
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
    children: observedChildren(nodes, full, histories, rawPrs, stopped, refs, new Map(ownUws)),
    reviews: reviewsFromEvents(epicHistory),
    hooks: hooksFromEvents(epicHistory),
  }
  return { facts, epicHistory }
}
