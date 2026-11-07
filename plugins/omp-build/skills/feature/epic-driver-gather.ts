import { type NativeEpicPullRequest, readNativeEpicChildren } from '../../adapters/github-native/epic-children.ts'
import { currentParentIntegration } from '../../roxabi/uw-parent-current-integration.ts'
import {
  type CanonicalEpic,
  epicChildCompletion,
  epicDependency,
  issueNumber,
  readCanonicalEpic,
} from './epic-driver-canonical'
import {
  armedPullRequests,
  baseCi,
  branchRefs,
  issueHistory,
  prFacts,
  pullRequestsForChild,
  repoName,
  stoppedReviews,
  tree,
} from './epic-driver-github'
import { type Gathered, hooksFromEvents, reviewsFromEvents, stopsFromEvents } from './epic-driver-history'
import { git, graphql, Refused } from './epic-driver-runtime'
import type { BranchFacts, ChildFacts, Facts, OwnUwObservation } from './epic-types'
import { readLanding } from './workflow-readiness.js'

function observedChild(
  node: CanonicalEpic['nodes'][number],
  full: string,
  native: CanonicalEpic['native'],
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  armed: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUw: OwnUwObservation,
  canonical: CanonicalEpic,
): ChildFacts {
  const number = issueNumber(node.uw)
  const body = node.raw.body
  const completion = canonical.completion.completions.get(`${node.uw.repository}\0${node.uw.target}`)
  const canonicalHistories = canonical.parent.histories.filter(
    (candidate) =>
      candidate.source.scope.repository === node.uw.repository && candidate.source.scope.target === node.uw.target,
  )
  const canonicalHistory = canonicalHistories[0]
  if (canonicalHistories.length !== 1 || canonicalHistory === undefined || !canonicalHistory.source.complete)
    throw new Refused(`#${number} has no unique complete same-cut history`)
  if (/<!--\s*omp-build:epic-fix\b/.test(body)) {
    throw new Refused(`#${number} has a legacy epic-fix body marker; remove it from the issue body`)
  }
  return {
    number,
    title: node.title,
    state: node.native.state,
    stateReason: node.native.stateReason,
    labels: [...node.labels],
    body,
    ownUw,
    initialMandate: canonical.initialMandates.get(number) ?? {
      status: 'held',
      reason: 'Child initialization was not observed',
    },
    completion: epicChildCompletion(canonical, node.uw),
    ...(completion?.state === 'complete'
      ? { completionCode: { role: completion.role, code: completion.code, sources: completion.sources } }
      : {}),
    blockedBy: node.blockers.map((scope) => {
      const blocker = native.get(`${scope.repository}\0${scope.target}`)
      if (blocker === undefined) throw new Refused(`native blocker ${scope.target} was not observed`)
      return {
        number: issueNumber(scope),
        state: blocker.native.state,
        stateReason: blocker.native.stateReason,
        dependency: epicDependency(canonical, scope),
        ...(scope.repository === full ? {} : { repo: scope.repository }),
      }
    }),
    stops: stopsFromEvents(canonicalHistory),
    prs: (rawPrs.get(number) ?? []).map((pr) => prFacts(pr, stopped, armed)),
    branches: refs.get(number) ?? [],
  }
}

function observedChildren(
  nodes: readonly CanonicalEpic['nodes'][number][],
  full: string,
  native: CanonicalEpic['native'],
  rawPrs: Map<number, NativeEpicPullRequest[]>,
  stopped: Set<number>,
  armed: Set<number>,
  refs: Map<number, BranchFacts[]>,
  ownUws: Map<number, OwnUwObservation>,
  canonical: CanonicalEpic,
): ChildFacts[] {
  return nodes.map((node) => {
    const number = issueNumber(node.uw)
    const ownUw = ownUws.get(number)
    if (ownUw === undefined) throw new Error(`missing own UW observation for #${number}`)
    return observedChild(node, full, native, rawPrs, stopped, armed, refs, ownUw, canonical)
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
  const armed = await armedPullRequests(repo, [...rawPrs.values()].flat())
  const numbers = nodes.map((node) => issueNumber(node.uw))
  const epicHistory = await issueHistory(repo, full, epic)
  const refs = withGit ? branchRefs(repo, base, numbers) : new Map<number, BranchFacts[]>()
  const baseSha = withGit ? git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) : ''
  const { landing, landingError } = landingObservation(repo, base, dashboard)
  const children = observedChildren(nodes, full, native, rawPrs, stopped, armed, refs, ownUws, canonical)
  const facts: Facts = {
    epic,
    run,
    base,
    baseSha,
    parentIntegration: withGit
      ? currentParentIntegration(canonical.parent, baseSha, git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']))
      : {
          ok: false,
          diagnostics: [
            {
              code: 'record-unreadable',
              message: 'Current Parent candidate head was not observed',
              location: { kind: 'native', uw: canonical.parent.uw, connection: 'state' },
              related: [],
            },
          ],
        },
    parentCompletion: canonical.completion.completions.get(`${full}\0${full}#${epic}`) ?? null,
    tree: withGit ? tree(repo) : { clean: true, branch: null },
    baseCi: !dashboard
      ? { state: 'unread', failed: [], pending: [] }
      : withGit && landing
        ? baseCi(repo, owner, name, baseSha, landing.required_checks)
        : { state: 'none', failed: [], pending: [] },
    landingError,
    children,
    reviews: await reviewsFromEvents(repo, epicHistory),
    hooks: hooksFromEvents(epicHistory),
  }
  return { facts, epicHistory, parentAdmission }
}
