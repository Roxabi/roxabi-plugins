import { execFileSync } from 'node:child_process'

const SHA = /^[0-9a-f]{40}$/

export type HostGitIdentity = {
  repository: string
  commit: string
  tree: string
}

export type HostGitObserver = (cwd: string) => HostGitIdentity | null

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function repositoryOf(origin: string): string | null {
  const line = origin.replace(/\.git$/, '')
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(line)
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) return `${ssh[1]}/${ssh[2]}`
  const https = /^(?:ssh:\/\/git@|https:\/\/|git:\/\/)github\.com\/([^/\s]+)\/([^/\s]+)$/.exec(line)
  if (https?.[1] !== undefined && https[2] !== undefined) return `${https[1]}/${https[2]}`
  return null
}

/** Host observation of one directory. Dirty, missing, or unreadable git state is null, never a parsed command string. */
export function observeHostGit(cwd: string): HostGitIdentity | null {
  const commit = git(cwd, ['rev-parse', '--verify', 'HEAD'])
  const tree = git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const status = git(cwd, ['status', '--porcelain'])
  const origin = git(cwd, ['remote', 'get-url', 'origin'])
  if (commit === null || tree === null || status === null || origin === null) return null
  if (status !== '') return null
  if (!SHA.test(commit) || !SHA.test(tree)) return null
  const repository = repositoryOf(origin)
  if (repository === null) return null
  return { repository, commit, tree }
}
