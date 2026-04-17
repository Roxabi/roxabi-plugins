import { GH_PROJECT_ID, GITHUB_REPO, PRIORITY_ORDER, SIZE_ORDER } from '../../shared/adapters/config-helpers'
import { ghGraphQL } from '../../shared/adapters/github-adapter'
import {
  BRANCH_CI_QUERY,
  buildBatchedQuery,
  buildBatchedVariables,
  ISSUES_QUERY,
  PRS_QUERY,
} from '../../shared/queries'
import type { RawItem } from '../../shared/types'

import type { BranchCI, CICheck, Issue, PR } from './types'

interface SlotNames {
  col2: string
  col3: string
}
const DEFAULT_SLOTS: SlotNames = { col2: 'Size', col3: 'Priority' }

interface RawCheckNode {
  __typename?: string
  name?: string
  context?: string
  status?: string
  state?: string
  conclusion?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawPRNode {
  number: number
  title: string
  headRefName: string
  state: string
  isDraft: boolean
  url: string
  author: { login: string } | null
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string | null
  labels: { nodes: { name: string }[] }
  mergeable: string
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          contexts: { nodes: RawCheckNode[] }
        } | null
      }
    }[]
  }
}

interface RawBranchRef {
  name: string
  target: {
    oid: string
    messageHeadline: string
    committedDate: string
    statusCheckRollup: {
      state: string
      contexts: { nodes: RawCheckNode[] }
    } | null
  } | null
}

/** Fetch all raw items for a project with full cursor-based pagination. */
export async function fetchAllItemsForProject(projectId: string): Promise<RawItem[]> {
  const allItems: RawItem[] = []
  let cursor: string | undefined
  do {
    const variables: Record<string, string> = { projectId }
    if (cursor) variables.cursor = cursor
    const data = (await ghGraphQL(ISSUES_QUERY, variables)) as {
      data: {
        node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawItem[] } }
      }
    }
    const page = data.data.node.items
    allItems.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (cursor)
  return allItems
}

/** Fetch all raw project items with pagination. */
export async function fetchAllItems(): Promise<RawItem[]> {
  if (!GH_PROJECT_ID) {
    throw new Error(
      'GH_PROJECT_ID not configured and no GitHub Project V2 board linked to this repo.\n' +
        'Run `/github-setup` to create one, or set gh_project_id in .claude/dev-core.yml',
    )
  }
  return fetchAllItemsForProject(GH_PROJECT_ID)
}

export type FetchAllProjectsResult = {
  items: Map<string, RawItem[]>
  /** Labels of projects that hit the 100-item limit and may have more issues not displayed. */
  truncated: string[]
}

/**
 * Fetch all issues for multiple projects in a single batched GraphQL call.
 * Returns items keyed by label, and a list of labels that were truncated at 100.
 */
export async function fetchAllProjects(
  projects: Array<{ label: string; projectId: string }>,
): Promise<FetchAllProjectsResult> {
  if (projects.length === 0) return { items: new Map(), truncated: [] }

  const projectIds = projects.map((p) => p.projectId)
  const query = buildBatchedQuery(projectIds)
  const variables = buildBatchedVariables(projectIds)

  const data = (await ghGraphQL(query, variables)) as {
    data: Record<string, { items: { nodes: RawItem[]; pageInfo: { hasNextPage: boolean } } } | null>
  }

  const items = new Map<string, RawItem[]>()
  const truncated: string[] = []
  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i]
    const page = data.data[`project${i}`]
    items.set(proj.label, page?.items.nodes ?? [])
    if (page?.items.pageInfo.hasNextPage) truncated.push(proj.label)
  }
  return { items, truncated }
}

export function rawItemsToIssues(items: RawItem[], slotNames: SlotNames = DEFAULT_SLOTS): Issue[] {
  const openItems = items.filter((i) => i.content?.state === 'OPEN')

  const field = (item: RawItem, name: string): string => {
    for (const fv of item.fieldValues.nodes) {
      if (fv.field?.name === name && fv.name) return fv.name
    }
    return '-'
  }

  const byNumber = new Map<number, RawItem>()
  for (const item of openItems) byNumber.set(item.content.number, item)

  const toIssue = (item: RawItem): Issue => {
    const bb = item.content.blockedBy?.nodes ?? []
    const bl = item.content.blocking?.nodes ?? []
    const openBlockedBy = bb.filter((b) => b.state === 'OPEN')

    let blockStatus: Issue['blockStatus'] = 'ready'
    if (openBlockedBy.length > 0) blockStatus = 'blocked'
    else if (bl.length > 0) blockStatus = 'blocking'

    const subs = item.content.subIssues?.nodes ?? []
    const children: Issue[] = subs
      .map((sub) => {
        const child = byNumber.get(sub.number)
        if (!child) return null
        return toIssue(child)
      })
      .filter(Boolean) as Issue[]

    return {
      number: item.content.number,
      title: item.content.title,
      url: item.content.url,
      status: field(item, 'Status'),
      size: field(item, slotNames.col2),
      priority: field(item, slotNames.col3),
      blockStatus,
      blockedBy: bb,
      blocking: bl,
      children,
    }
  }

  // Root issues only (no open parent); orphaned children (parent closed) promoted to root
  const roots = openItems.filter((i) => !i.content.parent || i.content.parent.state === 'CLOSED').map(toIssue)

  // Sort: priority P0→PX, then size XL→S
  roots.sort((a, b) => {
    const pd = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    if (pd !== 0) return pd
    return (SIZE_ORDER[a.size] ?? 99) - (SIZE_ORDER[b.size] ?? 99)
  })

  return roots
}

export async function fetchIssues(): Promise<Issue[]> {
  const items = await fetchAllItems()
  return rawItemsToIssues(items)
}

export async function fetchPRs(repoSlug: string = GITHUB_REPO): Promise<PR[]> {
  try {
    const [owner, repo] = repoSlug.split('/')
    const data = (await ghGraphQL(PRS_QUERY, { owner, repo })) as {
      data: { repository: { pullRequests: { nodes: RawPRNode[] } } }
    }

    return data.data.repository.pullRequests.nodes.map((pr) => {
      const commitNode = pr.commits.nodes[0]
      const rawChecks = commitNode?.commit.statusCheckRollup?.contexts.nodes ?? []
      const checks: CICheck[] = rawChecks.map((c) => ({
        name: c.name || c.context || 'unknown',
        status: c.status || c.state || '',
        conclusion: c.conclusion || '',
        detailsUrl: c.detailsUrl || c.targetUrl || '',
      }))

      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        state: pr.state,
        isDraft: pr.isDraft,
        url: pr.url,
        author: pr.author?.login ?? '',
        updatedAt: pr.updatedAt,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        reviewDecision: pr.reviewDecision ?? '',
        labels: pr.labels.nodes.map((l) => l.name),
        mergeable: pr.mergeable ?? 'UNKNOWN',
        checks,
      }
    })
  } catch {
    return []
  }
}

export async function fetchBranchCI(repoSlug: string = GITHUB_REPO): Promise<BranchCI[]> {
  try {
    const [owner, repo] = repoSlug.split('/')
    const data = (await ghGraphQL(BRANCH_CI_QUERY, { owner, repo })) as {
      data: { repository: { main: RawBranchRef | null; master: RawBranchRef | null; staging: RawBranchRef | null } }
    }

    const refs: [string, RawBranchRef | null][] = [
      ['main', data.data.repository.main ?? data.data.repository.master],
      ['staging', data.data.repository.staging],
    ]

    return refs
      .filter((entry): entry is [string, RawBranchRef] => entry[1] !== null)
      .map(([branch, ref]) => {
        const target = ref.target
        if (!target) {
          return {
            branch,
            commitSha: '',
            commitMessage: '',
            committedAt: '',
            overallState: '',
            checks: [],
          }
        }
        const rawChecks = target.statusCheckRollup?.contexts.nodes ?? []
        const checks: CICheck[] = rawChecks.map((c) => ({
          name: c.name || c.context || 'unknown',
          status: c.status || c.state || '',
          conclusion: c.conclusion || '',
          detailsUrl: c.detailsUrl || c.targetUrl || '',
        }))
        return {
          branch,
          commitSha: target.oid.slice(0, 7),
          commitMessage: target.messageHeadline,
          committedAt: target.committedDate,
          overallState: target.statusCheckRollup?.state ?? '',
          checks,
        }
      })
  } catch {
    return []
  }
}
