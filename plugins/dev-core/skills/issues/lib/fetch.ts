import { GITHUB_REPO, PROJECT_ID } from '../../shared/config'
import { ghGraphQL, run } from '../../shared/github'
import { BRANCH_CI_QUERY, ISSUES_QUERY, PRS_QUERY } from '../../shared/queries'
import type { RawItem } from '../../shared/types'
import type {
  Branch,
  BranchCI,
  BuildStep,
  CICheck,
  Issue,
  PR,
  VercelDeployment,
  WorkflowRun,
  Worktree,
} from './types'

async function fetchPage(
  cursor?: string
): Promise<{ items: RawItem[]; hasNextPage: boolean; endCursor: string | null }> {
  const variables: Record<string, string> = { projectId: PROJECT_ID }
  if (cursor) variables.cursor = cursor

  const data = (await ghGraphQL(ISSUES_QUERY, variables)) as {
    data: {
      node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawItem[] } }
    }
  }
  const pageInfo = data.data.node.items.pageInfo
  return {
    items: data.data.node.items.nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  }
}

/** Fetch all raw project items with pagination. */
export async function fetchAllItems(): Promise<RawItem[]> {
  const allItems: RawItem[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    allItems.push(...page.items)
    cursor = page.hasNextPage ? (page.endCursor ?? undefined) : undefined
  } while (cursor)
  return allItems
}

export async function fetchIssues(): Promise<Issue[]> {
  const items = await fetchAllItems()
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
      size: field(item, 'Size'),
      priority: field(item, 'Priority'),
      blockStatus,
      blockedBy: bb,
      blocking: bl,
      children,
    }
  }

  // Root issues only (no open parent); orphaned children (parent closed) promoted to root
  const roots = openItems
    .filter((i) => !i.content.parent || i.content.parent.state === 'CLOSED')
    .map(toIssue)

  // Sort: status first (Review > In Progress > Specs > Analysis > Backlog),
  // then block status, then priority
  const statusOrder: Record<string, number> = {
    Review: 0,
    'In Progress': 1,
    Specs: 2,
    Analysis: 3,
    Backlog: 4,
    '-': 99,
  }
  const blockOrder: Record<string, number> = {
    blocking: 0,
    ready: 1,
    blocked: 2,
  }
  const priorityOrder: Record<string, number> = {
    'P0 - Urgent': 0,
    'P1 - High': 1,
    'P2 - Medium': 2,
    'P3 - Low': 3,
    '-': 99,
  }

  roots.sort((a, b) => {
    const sd = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99)
    if (sd !== 0) return sd
    const bd = (blockOrder[a.blockStatus] ?? 9) - (blockOrder[b.blockStatus] ?? 9)
    if (bd !== 0) return bd
    return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99)
  })

  return roots
}

export { run }

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

export async function fetchPRs(): Promise<PR[]> {
  try {
    const [owner, repo] = GITHUB_REPO.split('/')
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

export async function fetchBranches(): Promise<Branch[]> {
  try {
    const out = await run(['git', 'branch', '--list'])
    if (!out) return []
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        name: line.replace(/^[*+]?\s+/, ''),
        isCurrent: line.startsWith('*'),
      }))
  } catch {
    return []
  }
}

export async function fetchWorktrees(): Promise<Worktree[]> {
  try {
    const out = await run(['git', 'worktree', 'list', '--porcelain'])
    if (!out) return []
    const trees: Worktree[] = []
    let current: Partial<Worktree> = {}
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) trees.push(current as Worktree)
        current = { path: line.slice(9), branch: '', commit: '', isBare: false }
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.slice(5, 12)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === 'bare') {
        current.isBare = true
      }
    }
    if (current.path) trees.push(current as Worktree)
    return trees
  } catch {
    return []
  }
}

const VERCEL_PROJECT_ID = 'prj_zQBFlIxtRstBkgQkxb9UwNPlaQuv'
const VERCEL_TEAM_ID = 'team_aykdwlsiBnvKgB1hCKU7XsXy'
const FIVE_MINUTES = 5 * 60 * 1000

// Build phases detected from Vercel build log text
const BUILD_PHASES: { name: string; patterns: RegExp[] }[] = [
  { name: 'Provision', patterns: [/Running build in/] },
  { name: 'Download', patterns: [/Retrieving list|Downloading .* deployment files/] },
  { name: 'Install', patterns: [/Running "install"|bun install|npm install|yarn install/] },
  {
    name: 'Build',
    patterns: [/Running "vercel build"|Running "build"|turbo run build|vite build/],
  },
  { name: 'Deploy', patterns: [/Deploying outputs|Build completed|Serverless Function/] },
]

function parseBuildSteps(logs: string[], deployState: string): BuildStep[] {
  const reached = new Set<number>()
  for (const line of logs) {
    for (let i = 0; i < BUILD_PHASES.length; i++) {
      if (BUILD_PHASES[i].patterns.some((p) => p.test(line))) reached.add(i)
    }
  }

  const hasError =
    deployState === 'ERROR' || logs.some((l) => /^Error:|Command ".*" exited with \d+/.test(l))
  const maxReached = Math.max(-1, ...reached)

  return BUILD_PHASES.map((phase, i) => {
    if (i < maxReached) return { name: phase.name, status: 'done' as const }
    if (i === maxReached) {
      if (hasError) return { name: phase.name, status: 'error' as const }
      if (deployState === 'READY') return { name: phase.name, status: 'done' as const }
      return { name: phase.name, status: 'running' as const }
    }
    if (deployState === 'READY') return { name: phase.name, status: 'done' as const }
    return { name: phase.name, status: 'pending' as const }
  })
}

async function fetchBuildLogs(token: string, deploymentId: string): Promise<string[]> {
  try {
    const url = `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${VERCEL_TEAM_ID}&limit=200`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const events = (await res.json()) as { text: string; type: string }[]
    return events.map((e) => e.text).filter(Boolean)
  } catch {
    return []
  }
}

export async function fetchVercelDeployments(): Promise<VercelDeployment[]> {
  const token = process.env.VERCEL_TOKEN
  if (!token) return []

  try {
    const since = Date.now() - FIVE_MINUTES
    const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&limit=10&since=${since}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { deployments: RawVercelDeployment[] }

    const now = Date.now()
    const filtered = data.deployments
      .map((d) => ({
        uid: d.uid,
        url: d.url,
        state: d.state ?? d.readyState ?? '',
        target: d.target ?? '',
        createdAt: d.createdAt,
        buildingAt: d.buildingAt ?? 0,
        ready: d.ready ?? 0,
        source: d.source ?? '',
        meta: {
          githubCommitRef: d.meta?.githubCommitRef,
          githubCommitMessage: d.meta?.githubCommitMessage,
        },
        inspectorUrl: d.inspectorUrl ?? '',
        buildSteps: [] as BuildStep[],
      }))
      .filter((d) => {
        const ongoing = ['BUILDING', 'QUEUED', 'INITIALIZING'].includes(d.state)
        const recentReady = d.state === 'READY' && d.ready > 0 && now - d.ready < FIVE_MINUTES
        const recentError = d.state === 'ERROR' && now - d.createdAt < FIVE_MINUTES
        return ongoing || recentReady || recentError
      })

    // Fetch build logs in parallel for all visible deployments
    const logResults = await Promise.all(filtered.map((d) => fetchBuildLogs(token, d.uid)))
    for (let i = 0; i < filtered.length; i++) {
      filtered[i].buildSteps = parseBuildSteps(logResults[i], filtered[i].state)
    }

    return filtered
  } catch {
    return []
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

export async function fetchBranchCI(): Promise<BranchCI[]> {
  try {
    const [owner, repo] = GITHUB_REPO.split('/')
    const data = (await ghGraphQL(BRANCH_CI_QUERY, { owner, repo })) as {
      data: { repository: { main: RawBranchRef | null; staging: RawBranchRef | null } }
    }

    const refs: [string, RawBranchRef | null][] = [
      ['main', data.data.repository.main],
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

interface RawVercelDeployment {
  uid: string
  url: string
  state?: string
  readyState?: string
  target?: string
  createdAt: number
  buildingAt?: number
  ready?: number
  source?: string
  meta?: { githubCommitRef?: string; githubCommitMessage?: string }
  inspectorUrl?: string
}

interface RawWorkflowRun {
  id: number
  name: string
  display_title: string
  event: string
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
  head_branch: string
  head_commit?: { message: string } | null
}

const FIVE_MINUTES_WR = 5 * 60 * 1000

function getGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
    const token = new TextDecoder().decode(proc.stdout).trim()
    if (token) return token
  } catch {
    // gh not available
  }
  return ''
}

export async function fetchWorkflowRuns(): Promise<WorkflowRun[]> {
  const token = getGitHubToken()
  if (!token) return []

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/deploy-preview.yml/runs?per_page=10`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) return []

    const data = (await res.json()) as { workflow_runs: RawWorkflowRun[] }
    const now = Date.now()

    const filtered = data.workflow_runs.filter((run) => {
      const ongoing = run.status === 'in_progress' || run.status === 'queued'
      const recentCompleted =
        run.status === 'completed' && now - new Date(run.updated_at).getTime() < FIVE_MINUTES_WR
      return ongoing || recentCompleted
    })

    return filtered.map((run) => {
      const rawMsg = run.head_commit?.message ?? ''
      const firstLine = rawMsg.split('\n')[0]
      const headCommitMessage = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine

      return {
        id: run.id,
        name: run.name,
        displayTitle: run.display_title,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        headBranch: run.head_branch,
        headCommitMessage,
      }
    })
  } catch {
    return []
  }
}
