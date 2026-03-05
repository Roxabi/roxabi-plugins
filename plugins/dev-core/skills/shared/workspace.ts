/**
 * @deprecated Use GitWorkspaceAdapter from adapters/git-workspace.ts instead.
 *
 * Workspace config helpers — vendored copy for plugin use.
 * Retained as a shim for existing callers during migration.
 * Re-exports pure logic from adapters/workspace-helpers.ts.
 */

// Re-export functions from the adapter layer
export {
  discoverProject,
  getWorkspacePath,
  readWorkspace,
  writeWorkspace,
} from './adapters/workspace-helpers'
// Re-export types from canonical locations
export type { ProjectFieldIds } from './domain/types'
export type { VercelProjectRef, Workspace, WorkspaceProject } from './ports/workspace'

// ProjectType is not yet in ports/workspace — keep it here for backward compat
export type ProjectType = 'technical' | 'company'
