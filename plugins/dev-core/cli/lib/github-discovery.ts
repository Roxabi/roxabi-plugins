import { discoverProject as discoverProjectShared } from '../../skills/shared/adapters/github-discovery'
import type { WorkspaceProject } from '../../skills/shared/ports/workspace'
import { detectLocalPath } from './cwd-resolver'

export type { WorkspaceProject } from '../../skills/shared/ports/workspace'

/**
 * Discover GitHub Projects linked to a repo via GraphQL.
 * Thin cli wrapper: auto-detects localPath from cwd, then delegates to shared impl.
 */
export async function discoverProject(repo: string): Promise<WorkspaceProject[]> {
  return discoverProjectShared(repo, detectLocalPath(repo))
}
