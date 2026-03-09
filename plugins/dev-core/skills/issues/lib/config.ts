/**
 * Re-exports from shared config — issues skill uses the same constants.
 * Dashboard-specific additions (if any) go below the re-exports.
 */

export {
  FIELD_MAP,
  GH_PROJECT_ID,
  GITHUB_REPO,
  PRIORITY_OPTIONS,
  PRIORITY_ORDER,
  PRIORITY_SHORT,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
  STATUS_SHORT,
} from '../../shared/adapters/config-helpers'

export { ISSUES_QUERY as QUERY, ITEM_ID_QUERY, UPDATE_FIELD_MUTATION } from '../../shared/queries'

import { existsSync, readFileSync } from 'node:fs'
import { detectGitHubRepo } from '../../shared/adapters/config-helpers'

interface WorkspaceProject {
  repo: string
  projectId: string
  label: string
}
interface Workspace {
  projects: WorkspaceProject[]
}

function getWorkspacePath(): string {
  const home = process.env.HOME ?? ''
  const vault = `${home}/.roxabi-vault`
  if (existsSync(vault)) return `${vault}/workspace.json`
  return `${home}/.config/roxabi/workspace.json`
}

function readWorkspace(): Workspace {
  const p = getWorkspacePath()
  if (!existsSync(p)) return { projects: [] }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Workspace
  } catch {
    return { projects: [] }
  }
}

/**
 * Resolve project config for the current repo.
 * Priority 1: workspace.json entry matching current repo
 * Priority 2: .env / process.env fallback (GH_PROJECT_ID etc.)
 */
export function resolveConfig(): { projectId: string; source: 'workspace' | 'env' } {
  const ws = readWorkspace()
  let currentRepo = ''
  try {
    currentRepo = detectGitHubRepo()
  } catch {
    /* not in git repo */
  }
  if (currentRepo) {
    const entry = ws.projects.find((p) => p.repo === currentRepo)
    if (entry?.projectId) return { projectId: entry.projectId, source: 'workspace' }
  }
  const envId = process.env.GH_PROJECT_ID ?? ''
  return { projectId: envId, source: 'env' }
}
