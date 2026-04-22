import { existsSync, readFileSync, statSync } from 'node:fs'
import type { WorkspaceProject } from './workspace-store'

// GitHub repo slugs: owner/name. First character of each segment must be alphanumeric
// (matches GitHub's own rule that usernames and repo names cannot start with . - or _).
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
// Cap on .roxabi marker size. Defense against memory-pressure from a crafted file planted on walk-up path.
const ROXABI_MAX_BYTES = 64 * 1024

/**
 * Parse a git remote URL into 'owner/name'.
 * Handles SSH (git@host:owner/name.git), HTTPS (https://host/owner/name[.git]),
 * and ssh:// / git:// URLs. Returns null if the URL is not recognizable.
 */
export function parseGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '')
  // SSH shorthand: git@github.com:owner/name
  const ssh = trimmed.match(/^[^@\s]+@[^:\s]+:([^/\s]+)\/(.+)$/)
  if (ssh) {
    const slug = `${ssh[1]}/${ssh[2]}`
    return REPO_SLUG_RE.test(slug) ? slug : null
  }
  // Protocol URLs: https://, ssh://, git://
  const web = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\/(.+?)$/)
  if (web) {
    const slug = `${web[1]}/${web[2]}`
    return REPO_SLUG_RE.test(slug) ? slug : null
  }
  return null
}

/**
 * Resolve the repository slug ('owner/name') for a working directory.
 * Order: .roxabi marker walk-up → `git remote get-url origin` parse.
 * Returns null if no source yields a slug.
 *
 * `.roxabi` marker format:
 *   - JSON object with a single required `repo` field (string, `REPO_SLUG_RE`).
 *   - Extra fields are ignored (forward-compatible).
 *   - Size cap: `ROXABI_MAX_BYTES` (64 KB).
 *   - Example: `{ "repo": "Roxabi/my-sub-project" }`
 * Markers that fail size, JSON, shape, or slug validation are silently
 * ignored so resolution falls through to `git remote origin`.
 */
export function resolveRepoFromCwd(cwd: string): string | null {
  // 1. .roxabi marker walk-up (supports monorepos / subdirs)
  let dir = cwd
  while (dir.length > 1) {
    const marker = `${dir}/.roxabi`
    if (existsSync(marker)) {
      try {
        if (statSync(marker).size <= ROXABI_MAX_BYTES) {
          const data = JSON.parse(readFileSync(marker, 'utf8')) as unknown
          if (data && typeof data === 'object' && 'repo' in data) {
            const repo = (data as { repo: unknown }).repo
            if (typeof repo === 'string' && REPO_SLUG_RE.test(repo)) return repo
          }
        }
      } catch {
        // ignore malformed marker, fall through to git remote
      }
    }
    const parent = dir.substring(0, dir.lastIndexOf('/')) || '/'
    if (parent === dir) break
    dir = parent
  }

  // 2. git remote origin
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) return null
    const url = new TextDecoder().decode(proc.stdout).trim()
    return parseGitRemoteUrl(url)
  } catch {
    return null
  }
}

/**
 * Resolve a cwd to a registered project entry.
 * Order: exact localPath → prefix localPath → .roxabi marker or git remote origin.
 */
export function resolveCurrentProject(projects: WorkspaceProject[], cwd: string): WorkspaceProject | null {
  const byPath =
    projects.find((p) => p.localPath && cwd === p.localPath) ??
    projects.find((p) => p.localPath && cwd.startsWith(`${p.localPath}/`))
  if (byPath) return byPath

  const slug = resolveRepoFromCwd(cwd)
  if (!slug) return null
  const needle = slug.toLowerCase()
  return projects.find((p) => p.repo.toLowerCase() === needle) ?? null
}

/**
 * Return cwd if it matches the requested repo slug.
 * Users must provide --local <path> when their clone is not at cwd.
 */
export function detectLocalPath(repo: string): string | undefined {
  const cwd = process.cwd()
  return resolveRepoFromCwd(cwd)?.toLowerCase() === repo.toLowerCase() ? cwd : undefined
}
