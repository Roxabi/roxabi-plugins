/**
 * Read-only discovery of current project state.
 * Returns structured JSON for the init orchestrator.
 */

import { STANDARD_LABELS, STANDARD_WORKFLOWS, PROTECTED_BRANCHES } from '../../shared/config'
import { checkPrereqs } from '../../shared/prereqs'
import { run, parseProjectFields, getBoardIssueNumbers } from '../../shared/github'

export interface DiscoveryResult {
  repo: string | null
  owner: string | null
  projects: Array<{ id: string; number: number; title: string }>
  fields: {
    status: { id: string; options: Record<string, string> } | null
    size: { id: string; options: Record<string, string> } | null
    priority: { id: string; options: Record<string, string> } | null
  }
  issues: { total: number; onBoard: number; orphaned: number }
  labels: { existing: string[]; missing: string[] }
  workflows: { existing: string[]; missing: string[] }
  protection: Record<string, boolean>
  vercel: { projectId: string; orgId: string } | null
  env: Record<string, string>
}

function readEnvFile(): Record<string, string> {
  try {
    const text = require('fs').readFileSync('.env', 'utf8') as string
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
  } catch {
    return {}
  }
}

export async function discover(): Promise<DiscoveryResult> {
  const prereqs = checkPrereqs()
  const owner = prereqs.gitRemote.owner || null
  const repo = prereqs.gitRemote.repo || null
  const ghOk = prereqs.gh.ok

  const result: DiscoveryResult = {
    repo,
    owner,
    projects: [],
    fields: { status: null, size: null, priority: null },
    issues: { total: 0, onBoard: 0, orphaned: 0 },
    labels: { existing: [], missing: [] },
    workflows: { existing: [], missing: [] },
    protection: {},
    vercel: null,
    env: readEnvFile(),
  }

  if (!ghOk || !owner) return result

  // Projects
  try {
    const projectsJson = await run(['gh', 'project', 'list', '--owner', owner, '--format', 'json', '--limit', '20'])
    const data = JSON.parse(projectsJson) as { projects: { id: string; number: number; title: string }[] }
    result.projects = data.projects ?? []
  } catch {}

  // Fields (if we have a project)
  const envData = result.env
  const projectId = envData.PROJECT_ID
  if (projectId && result.projects.length > 0) {
    const project = result.projects.find((p) => p.id === projectId) ?? result.projects[0]
    try {
      const fieldsJson = await run(['gh', 'project', 'field-list', String(project.number), '--owner', owner, '--format', 'json'])
      const parsed = parseProjectFields(fieldsJson)
      result.fields.status = parsed.status
      result.fields.size = parsed.size
      result.fields.priority = parsed.priority
    } catch {}
  }

  // Issues — count open issues and how many are on the board
  if (repo) {
    try {
      const issuesJson = await run(['gh', 'issue', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--json', 'number', '--limit', '500'])
      const issues = JSON.parse(issuesJson) as Array<{ number: number }>
      result.issues.total = issues.length

      // If we have a project, check which issues are already on the board
      const selectedProject = projectId
        ? result.projects.find((p) => p.id === projectId)
        : result.projects[0]
      if (selectedProject && issues.length > 0) {
        try {
          const onBoardNumbers = await getBoardIssueNumbers(owner!, selectedProject.number)
          const onBoard = issues.filter((i) => onBoardNumbers.has(i.number)).length
          result.issues.onBoard = onBoard
          result.issues.orphaned = result.issues.total - onBoard
        } catch {}
      } else {
        result.issues.orphaned = result.issues.total
      }
    } catch {}
  }

  // Labels
  try {
    const labelsJson = await run(['gh', 'label', 'list', '--repo', `${owner}/${repo}`, '--json', 'name', '--limit', '100'])
    const labels = (JSON.parse(labelsJson) as { name: string }[]).map((l) => l.name)
    result.labels.existing = labels
    result.labels.missing = STANDARD_LABELS.filter((l) => !labels.includes(l.name)).map((l) => l.name)
  } catch {}

  // Workflows
  for (const wf of STANDARD_WORKFLOWS) {
    if (require('fs').existsSync(`.github/workflows/${wf}`)) {
      result.workflows.existing.push(wf)
    } else {
      result.workflows.missing.push(wf)
    }
  }

  // Branch protection (parallel)
  const protectionChecks = await Promise.all(
    PROTECTED_BRANCHES.map((branch) =>
      run(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}/protection`])
        .then(() => ({ branch, ok: true }))
        .catch(() => ({ branch, ok: false }))
    )
  )
  for (const { branch, ok } of protectionChecks) {
    result.protection[branch] = ok
  }

  // Vercel
  try {
    const vercelJson = require('fs').readFileSync('.vercel/project.json', 'utf8')
    const vercel = JSON.parse(vercelJson) as { projectId?: string; orgId?: string }
    if (vercel.projectId) {
      result.vercel = { projectId: vercel.projectId, orgId: vercel.orgId ?? '' }
    }
  } catch {}

  return result
}
