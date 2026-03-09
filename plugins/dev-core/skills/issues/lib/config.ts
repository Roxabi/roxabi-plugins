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

import { detectGitHubRepo } from '../../shared/adapters/config-helpers'
import { readWorkspace } from '../../shared/adapters/workspace-helpers'

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
