import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ProjectFieldIds } from '../../skills/shared/domain/types'

export interface VercelProjectRef {
  projectId: string
  teamId: string
}

export interface WorkspaceProject {
  repo: string // 'owner/name'
  projectId: string // 'PVT_...'
  label: string // display name shown in dashboard tab
  localPath?: string // absolute path to local clone — used by dashboard for git ops
  type?: 'technical' | 'company' // project type for field slot naming
  fieldIds?: ProjectFieldIds // per-project field IDs and option IDs
  vercelProjectId?: string // single Vercel project ID (legacy / single-project)
  vercelTeamId?: string // Vercel team ID for single project
  vercelProjects?: VercelProjectRef[] // multiple Vercel projects (overrides vercelProjectId)
}

export interface Workspace {
  projects: WorkspaceProject[]
  roadmapProjectId?: string // optional roadmap project for cross-repo items
}

export function getWorkspacePath(): string {
  const home = process.env.HOME ?? ''
  const vault = `${home}/.roxabi-vault`
  if (existsSync(vault)) return `${vault}/workspace.json`
  return `${home}/.config/roxabi/workspace.json`
}

export function readWorkspace(): Workspace {
  const p = getWorkspacePath()
  if (!existsSync(p)) return { projects: [] }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
  return parseWorkspace(raw)
}

/**
 * Validate an unknown value as a Workspace. Throws with a specific field path
 * on shape failures so the user can fix their workspace.json. Unlike the `.roxabi`
 * marker (which fails silently and falls back to git remote), workspace.json has
 * no fallback — fail-loud is the right default at this boundary.
 */
export function parseWorkspace(raw: unknown): Workspace {
  if (!raw || typeof raw !== 'object' || !('projects' in raw)) {
    throw new Error('workspace.json: expected object with `projects` array')
  }
  const obj = raw as Record<string, unknown>
  const projects = obj.projects
  if (!Array.isArray(projects)) {
    throw new Error('workspace.json: `projects` must be an array')
  }
  const roadmapProjectId =
    obj.roadmapProjectId !== undefined && typeof obj.roadmapProjectId === 'string'
      ? obj.roadmapProjectId
      : undefined
  return { projects: projects.map(validateProject), roadmapProjectId }
}

function validateProject(p: unknown, i: number): WorkspaceProject {
  if (!p || typeof p !== 'object') {
    throw new Error(`workspace.json: projects[${i}] must be an object`)
  }
  const obj = p as Record<string, unknown>
  for (const field of ['repo', 'projectId', 'label'] as const) {
    const v = obj[field]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`workspace.json: projects[${i}].${field} must be a non-empty string`)
    }
  }
  if (obj.localPath !== undefined && typeof obj.localPath !== 'string') {
    throw new Error(`workspace.json: projects[${i}].localPath must be a string if present`)
  }
  return obj as unknown as WorkspaceProject
}

export function writeWorkspace(ws: Workspace): void {
  const p = getWorkspacePath()
  const dir = p.substring(0, p.lastIndexOf('/'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(p, `${JSON.stringify(ws, null, 2)}\n`, { mode: 0o600 })
}
