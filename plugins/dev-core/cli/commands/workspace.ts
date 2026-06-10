import type { WorkspaceProject } from '../lib/workspace-store'
import { readWorkspace, writeWorkspace } from '../lib/workspace-store'

const USAGE = `
Usage:
  roxabi workspace list
  roxabi workspace add <owner/repo> [--local <path>]
  roxabi workspace remove <owner/repo>
`.trim()

function validateLocalPath(path: string): string {
  // Reject path traversal — the only security guard needed for user-provided paths.
  // Absolute paths (/home/user/repo) and relative paths (./repo) are valid.
  if (path.includes('..')) {
    throw new Error(`Invalid --local path: '${path}' must not contain '..'`)
  }
  return path
}

function printTable(projects: WorkspaceProject[]): void {
  if (projects.length === 0) {
    console.log('No projects registered. Run: roxabi workspace add owner/repo')
    return
  }

  const repoW = Math.max('repo'.length, ...projects.map((p) => p.repo.length))
  const labelW = Math.max('label'.length, ...projects.map((p) => p.label.length))
  const localW = Math.max('local'.length, ...projects.map((p) => (p.localPath ?? '').length))

  const row = (r: string, l: string, lp: string) => `${r.padEnd(repoW)}  ${l.padEnd(labelW)}  ${lp.padEnd(localW)}`

  console.log(row('repo', 'label', 'local'))
  console.log('-'.repeat(repoW + labelW + localW + 4))
  for (const p of projects) {
    console.log(row(p.repo, p.label, p.localPath ?? ''))
  }
}

async function cmdList(): Promise<void> {
  const ws = readWorkspace()
  printTable(ws.projects)
}

async function cmdAdd(repo: string, localPath?: string): Promise<void> {
  if (!repo) {
    console.error('Usage: roxabi workspace add <owner/repo> [--local <path>]')
    process.exit(1)
  }

  if (localPath !== undefined) {
    try {
      validateLocalPath(localPath)
    } catch (e) {
      console.error(String(e))
      process.exit(1)
    }
  }

  // ProjectV2 board discovery was removed in #268 — `add` now registers the repo
  // directly. The label defaults to the repo slug; --local records the clone path.
  const entry: WorkspaceProject = { repo, label: repo, ...(localPath !== undefined ? { localPath } : {}) }

  const ws = readWorkspace()
  const existing = ws.projects.findIndex((p) => p.repo === repo)
  if (existing !== -1) {
    ws.projects[existing] = entry
  } else {
    ws.projects.push(entry)
  }
  writeWorkspace(ws)
  console.log(`Added: ${entry.repo} → ${entry.label}`)
}

async function cmdRemove(repo: string): Promise<void> {
  if (!repo) {
    console.error('Usage: roxabi workspace remove <owner/repo>')
    process.exit(1)
  }

  const ws = readWorkspace()
  const idx = ws.projects.findIndex((p) => p.repo === repo)
  if (idx === -1) {
    console.error(`Error: '${repo}' is not registered in the workspace.`)
    process.exit(1)
    return
  }

  ws.projects.splice(idx, 1)
  writeWorkspace(ws)
  console.log(`Removed: ${repo}`)
  process.exit(0)
}

export async function run(args: string[]): Promise<void> {
  const sub = args[0]

  switch (sub) {
    case 'list':
      await cmdList()
      break

    case 'add': {
      const localIdx = args.indexOf('--local')
      const localPath = localIdx !== -1 ? args[localIdx + 1] : undefined
      const repo = args[1] && args[1] !== '--local' ? args[1] : ''
      await cmdAdd(repo, localPath)
      break
    }

    case 'remove':
      await cmdRemove(args[1] ?? '')
      break

    default:
      if (sub) {
        console.error(`Unknown workspace subcommand: ${sub}`)
      }
      console.log(USAGE)
      process.exit(sub ? 1 : 0)
  }
}
