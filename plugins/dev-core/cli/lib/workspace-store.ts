import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export interface VercelProjectRef {
  projectId: string
  teamId: string
}

export interface WorkspaceProject {
  repo: string // 'owner/name'
  projectId: string // 'PVT_...'
  label: string // display name shown in dashboard tab
  localPath?: string // absolute path to local clone — used by dashboard for git ops
  vercelProjectId?: string // single Vercel project ID (legacy / single-project)
  vercelTeamId?: string // Vercel team ID for single project
  vercelProjects?: VercelProjectRef[] // multiple Vercel projects (overrides vercelProjectId)
}

export interface Workspace {
  projects: WorkspaceProject[]
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
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Workspace
  } catch {
    return { projects: [] }
  }
}

export function writeWorkspace(ws: Workspace): void {
  const p = getWorkspacePath()
  const dir = p.substring(0, p.lastIndexOf('/'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(p, `${JSON.stringify(ws, null, 2)}\n`, { mode: 0o600 })
}
