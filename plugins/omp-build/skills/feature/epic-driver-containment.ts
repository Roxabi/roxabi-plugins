import { type DecodedHistory, githubScope, selectWorkflowBinding } from '../../dist/contracts.js'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { issueHistory } from './epic-driver-github'
import { graphql, Refused } from './epic-driver-runtime'

// Issue links and mandate branches discover candidates; neither grants authority.
const QUERY = `query EpicContainmentIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number repository { nameWithOwner }
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage } nodes { number state baseRefName headRefName isCrossRepository repository { nameWithOwner } }
      }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) {
        pageInfo { hasPreviousPage } nodes { ... on CrossReferencedEvent {
          source { __typename ... on PullRequest { number state baseRefName headRefName isCrossRepository repository { nameWithOwner } } }
        } }
      }
    }
  }
}`

const BRANCH_QUERY = `query EpicContainmentBranch($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, headRefName: $head, states: OPEN) {
      pageInfo { hasNextPage }
      nodes { number state baseRefName headRefName isCrossRepository repository { nameWithOwner } }
    }
  }
}`

type Candidate = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefName: string
  isCrossRepository: boolean
  repository: { nameWithOwner: string }
}
type IssueResponse = {
  repository: {
    issue: {
      number: number
      repository: { nameWithOwner: string }
      closedByPullRequestsReferences: { pageInfo: { hasNextPage: boolean }; nodes: Candidate[] }
      timelineItems: {
        pageInfo: { hasPreviousPage: boolean }
        nodes: { source: (Candidate & { __typename: string }) | { __typename: string } | null }[]
      }
    } | null
  }
}
type Scope = { repository: string; target: string }
type Owner = { repo: string; full: string; epic: number; mandateId: string; child: Scope; number: number }

function repository(full: string): { owner: string; name: string } {
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Refused(`containment repository ${full} is invalid`)
  return { owner, name }
}

function candidate(value: unknown): value is Candidate {
  if (value === null || typeof value !== 'object') return false
  const pr = value as Partial<Candidate>
  return (
    Number.isSafeInteger(pr.number) &&
    (pr.number ?? 0) > 0 &&
    (pr.state === 'OPEN' || pr.state === 'CLOSED' || pr.state === 'MERGED') &&
    typeof pr.baseRefName === 'string' &&
    pr.baseRefName.length > 0 &&
    typeof pr.headRefName === 'string' &&
    pr.headRefName.length > 0 &&
    typeof pr.isCrossRepository === 'boolean' &&
    typeof pr.repository?.nameWithOwner === 'string'
  )
}

function timelineCandidates(
  timeline: NonNullable<IssueResponse['repository']['issue']>['timelineItems'],
  target: string,
): unknown[] {
  const found: unknown[] = []
  for (const entry of timeline.nodes) {
    if (!entry || !('source' in entry)) throw new Refused(`containment timeline for ${target} is unreadable`)
    if (entry.source === null) continue
    if (entry.source.__typename === 'PullRequest') found.push(entry.source)
    else if (typeof entry.source.__typename !== 'string')
      throw new Refused(`containment timeline for ${target} is unreadable`)
  }
  return found
}

function uniqueCandidates(values: readonly unknown[], full: string, target: string): Candidate[] {
  const found = new Map<number, Candidate>()
  for (const value of values) {
    if (!candidate(value)) throw new Refused(`containment PR discovery for ${target} is unreadable`)
    if (value.isCrossRepository || value.repository.nameWithOwner !== full || value.state !== 'OPEN') continue
    const previous = found.get(value.number)
    if (previous && (previous.headRefName !== value.headRefName || previous.baseRefName !== value.baseRefName))
      throw new Refused(`containment PR #${value.number} has conflicting observations`)
    found.set(value.number, value)
  }
  return [...found.values()]
}

function exactIssueCandidates(context: Owner): Candidate[] {
  const { repo, full, number } = context
  const issue = graphql<IssueResponse>(repo, QUERY, { ...repository(full), number }).repository?.issue
  if (!issue || issue.number !== number || issue.repository?.nameWithOwner !== full)
    throw new Refused(`containment issue ${full}#${number} is inaccessible or mismatched`)
  const closed = issue.closedByPullRequestsReferences
  const timeline = issue.timelineItems
  if (
    !closed ||
    !timeline ||
    closed.pageInfo?.hasNextPage !== false ||
    timeline.pageInfo?.hasPreviousPage !== false ||
    !Array.isArray(closed.nodes) ||
    !Array.isArray(timeline.nodes)
  )
    throw new Refused(`containment PR discovery for ${full}#${number} is incomplete`)
  const target = `${full}#${number}`
  return uniqueCandidates([...closed.nodes, ...timelineCandidates(timeline, target)], full, target)
}

function branchCandidates(context: Owner, head: string): Candidate[] {
  const data = graphql<{ repository: { pullRequests: { pageInfo: { hasNextPage: boolean }; nodes: unknown[] } } }>(
    context.repo,
    BRANCH_QUERY,
    { ...repository(context.full), head },
  )
  const connection = data.repository?.pullRequests
  if (connection?.pageInfo?.hasNextPage !== false || !Array.isArray(connection.nodes))
    throw new Refused(`containment PR discovery for branch ${head} is incomplete`)
  const found = uniqueCandidates(connection.nodes, context.full, `branch ${head}`)
  if (found.some((pr) => pr.headRefName !== head))
    throw new Refused(`containment PR discovery for branch ${head} is unreadable`)
  return found
}

function ownedMandate(mandate: MandateRecord, context: Owner): boolean {
  const own = mandate.payload.ownSpec.uw
  const parent = mandate.payload.parent
  return (
    (mandate.payload.role === 'feature' || mandate.payload.role === 'epic') &&
    own.repository === context.full &&
    own.target === context.child.target &&
    parent?.kind === 'mandate' &&
    parent.scope.repository === context.full &&
    parent.scope.target === `${context.full}#${context.epic}` &&
    parent.recordId === context.mandateId
  )
}

function ownedBranches(history: DecodedHistory, context: Owner): Set<string> {
  const branches = new Set<string>()
  for (const operation of history.operations) {
    const record = operation.record
    if (operation.status !== 'complete' || operation.authority !== 'accounted' || record?.kind !== 'mandate') continue
    if (ownedMandate(record, context) && record.payload.branch) branches.add(record.payload.branch)
  }
  return branches
}

async function childCandidates(context: Owner): Promise<{ candidates: Candidate[]; history: DecodedHistory }> {
  const linked = exactIssueCandidates(context)
  const history = await issueHistory(context.repo, context.full, context.number)
  if (
    !history.source.complete ||
    history.operations.some((operation) => {
      const claimsMandate =
        operation.record?.kind === 'mandate' ||
        operation.kind === 'mandate' ||
        operation.claimedKinds.includes('mandate')
      return (
        claimsMandate &&
        (operation.status !== 'complete' || operation.record?.kind !== 'mandate' || operation.authority === 'authority')
      )
    })
  )
    throw new Refused(`containment history for ${context.child.target} is unconfirmed`)
  for (const branch of ownedBranches(history, context)) linked.push(...branchCandidates(context, branch))
  return { candidates: uniqueCandidates(linked, context.full, context.child.target), history }
}

async function authenticateCandidate(context: Owner, history: DecodedHistory, pr: Candidate): Promise<void> {
  const prHistory = await issueHistory(context.repo, context.full, pr.number)
  const selected = selectWorkflowBinding({
    pullRequest: githubScope(context.full, pr.number),
    histories: [prHistory, history],
    native: { branch: pr.headRefName, base: pr.baseRefName },
  })
  if (selected.status !== 'bound') throw new Refused(`containment PR #${pr.number} binding is ${selected.status}`)
  if (!ownedMandate(selected.mandateRecord, context))
    throw new Refused(`containment PR #${pr.number} is not owned by the selected parent mandate`)
}

function acceptedNumber(full: string, child: Scope): number {
  const prefix = `${full}#`
  if (child.repository !== full || !child.target.startsWith(prefix))
    throw new Refused(`containment accepted child ${child.target} is outside ${full}`)
  const number = Number(child.target.slice(prefix.length))
  if (!Number.isSafeInteger(number) || number <= 0 || child.target !== `${prefix}${number}`)
    throw new Refused(`containment accepted child ${child.target} is invalid`)
  return number
}

export async function discoverAcceptedChildPrs(
  repo: string,
  full: string,
  epic: number,
  mandateId: string,
  children: readonly { scope: Scope }[],
): Promise<{ ticket: number; pr: number }[]> {
  const found = new Map<number, { ticket: number; pr: number }>()
  for (const { scope: child } of children) {
    const number = acceptedNumber(full, child)
    const context = { repo, full, epic, mandateId, child, number }
    const { candidates, history } = await childCandidates(context)
    for (const pr of candidates) {
      await authenticateCandidate(context, history, pr)
      const prior = found.get(pr.number)
      if (prior && prior.ticket !== number) throw new Refused(`containment PR #${pr.number} has conflicting owners`)
      found.set(pr.number, { ticket: number, pr: pr.number })
    }
  }
  return [...found.values()]
}
