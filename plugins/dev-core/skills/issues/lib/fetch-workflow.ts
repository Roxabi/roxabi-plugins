import { GITHUB_REPO } from '../../shared/adapters/config-helpers'
import type { WorkflowRun } from './types'

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

export async function fetchWorkflowRuns(repoSlug: string = GITHUB_REPO): Promise<WorkflowRun[]> {
  const token = getGitHubToken()
  if (!token) return []

  try {
    const url = `https://api.github.com/repos/${repoSlug}/actions/workflows/deploy-preview.yml/runs?per_page=10`
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
      const recentCompleted = run.status === 'completed' && now - new Date(run.updated_at).getTime() < FIVE_MINUTES_WR
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
