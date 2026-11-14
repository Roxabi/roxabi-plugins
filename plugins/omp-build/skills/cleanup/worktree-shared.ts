import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type Changes = { tracked: number; untracked: number; ignored: number }
// `protected` keeps the worktree; the other kinds are recognized ignored artifacts that need path-bound confirmation.
type ArtifactKind = 'dependency' | 'cache' | 'build-output' | 'protected'
type IgnoredEntry = { path: string; kind: ArtifactKind }
type Row = {
  repository: string
  commonDir: string
  path: string
  branch: string | null
  head: string | null
  kind: string
  localChanges: Changes | null
  ignoredEntries: IgnoredEntry[]
  requiresArtifactConfirmation: boolean
  activity: 'idle' | 'active' | 'unknown'
  requiresUsageConfirmation: boolean
  warnings: string[]
  usageEvidence: string[]
  eligible: boolean
  reasons: string[]
  token: string
  [key: string]: unknown
}
type Report = {
  version: 1
  repositories: { path: string; commonDir: string }[]
  worktrees: Row[]
  errors: { path: string; message: string; scope?: 'repository' | 'worktree' | 'orphan-scan' }[]
  discoveryExclusions: { directoryNames: string[]; symlinks: string }
}
type Options = {
  command: 'inventory' | 'remove'
  repos: string[]
  roots: string[]
  scope?: string
  json: boolean
  target?: string
  expect?: string
  confirm?: string
  ackUnknownUsage?: string
  ackIgnoredArtifacts?: string
}

// Git hooks and parent shells can redirect even `git -C`; do not inherit any Git configuration or location overrides.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv
env.GIT_OPTIONAL_LOCKS = '0'
env.GIT_TERMINAL_PROMPT = '0'
const scanner = join(dirname(fileURLToPath(import.meta.url)), 'scan-orphan-worktree-shells.sh')
const excludedDirectories = [
  '.git',
  'node_modules',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.venv',
  '__pycache__',
  'vendor',
]
const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent === sep ? sep : parent + sep)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
function command(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0)
    throw new Error(`${cmd} ${args[0]}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`)
  return result.stdout
}
function git(cwd: string, ...args: string[]) {
  return command('git', ['-C', cwd, ...args], process.cwd())
}
function canonical(path: string) {
  return realpathSync(resolve(path))
}

export type { ArtifactKind, Changes, IgnoredEntry, Options, Report, Row }
export { canonical, command, excludedDirectories, git, inside, message, scanner }
