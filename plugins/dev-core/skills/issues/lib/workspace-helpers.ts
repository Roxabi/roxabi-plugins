import type { WorkspaceProject } from '../../shared/ports/workspace'

/**
 * Maps a raw workspace project entry (as stored in workspace.json) to a typed
 * WorkspaceProject, ensuring every field — including the optional `localPath` —
 * is forwarded.  This helper is used in both the workspace (multi-project) and
 * single-project code paths in dashboard.ts so that neither path accidentally
 * drops fields.
 */
export function toWorkspaceProject(p: {
  label: string
  repo: string
  projectId: string
  type?: WorkspaceProject['type']
  fieldIds?: WorkspaceProject['fieldIds']
  vercelProjects?: WorkspaceProject['vercelProjects']
  localPath?: string
}): WorkspaceProject {
  return {
    label: p.label,
    repo: p.repo,
    projectId: p.projectId,
    type: p.type,
    fieldIds: p.fieldIds,
    vercelProjects: p.vercelProjects,
    localPath: p.localPath,
  }
}
