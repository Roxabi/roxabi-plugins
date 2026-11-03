import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
const BOOTSTRAP_SCRIPT = fileURLToPath(new URL('../skills/feature/worktree-bootstrap.sh', import.meta.url))

export type CheckoutPreparation =
  | { status: 'ready'; cwd: string; principal: boolean }
  | { status: 'move'; path: string; instruction: `/move ${string}` }
  | { status: 'blocked'; reason: string }

function moveInstruction<P extends string>(path: P): `/move ${P}` {
  return `/move ${path}`
}

export type SessionWorktreeIdentity =
  | { ok: true; sessionTop: string; principalTop: string; onPrincipal: boolean }
  | { ok: false; reason: string }

type Worktree = { path: string; branch: string | null; detached: boolean }

function failedGitStatus(error: object): number {
  if (!('status' in error) || typeof error.status !== 'number') return 1
  return error.status
}

function failedGitOutput(error: object, field: 'stdout' | 'stderr'): string {
  if (field === 'stdout') return 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  return 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
}

function failedGitResult(error: unknown): { code: number; stdout: string; stderr: string } {
  if (error === null || typeof error !== 'object') return { code: 1, stdout: '', stderr: '' }
  return {
    code: failedGitStatus(error),
    stdout: failedGitOutput(error, 'stdout'),
    stderr: failedGitOutput(error, 'stderr'),
  }
}

export function defaultGit(): GitRunner {
  return async (cwd, args) => {
    try {
      const out = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
      return { code: 0, stdout: out.stdout, stderr: out.stderr }
    } catch (error) {
      return failedGitResult(error)
    }
  }
}

function parseWorktrees(porcelain: string): Worktree[] {
  const trees: Worktree[] = []
  let current: Worktree | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current)
      current = { path: line.slice('worktree '.length), branch: null, detached: false }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    } else if (current && line === 'detached') {
      current.detached = true
    }
  }
  if (current) trees.push(current)
  return trees
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}

/**
 * Real Git checkout identity. Caller `principal: false` is not authority —
 * the first `git worktree list --porcelain` path is the principal.
 */
export async function sessionWorktreeIdentity(git: GitRunner, cwd: string): Promise<SessionWorktreeIdentity> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { ok: false, reason: 'session-not-a-worktree' }
  const sessionTop = top.stdout.trim()
  const listed = await git(sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return { ok: false, reason: 'worktree-list-unreadable' }
  const trees = parseWorktrees(listed.stdout)
  const principalTop = trees[0]?.path
  if (!principalTop) return { ok: false, reason: 'principal-unreadable' }
  return {
    ok: true,
    sessionTop,
    principalTop,
    onPrincipal: samePath(sessionTop, principalTop),
  }
}

/**
 * Foreground idempotent bootstrap. Reuses skills/feature/worktree-bootstrap.sh
 * marker `omp-build-bootstrapped` and symlink lock; no second setup protocol.
 */
export async function runWorktreeBootstrap(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const out = await execFileAsync('bash', [BOOTSTRAP_SCRIPT], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    void out
    return { ok: true }
  } catch (error) {
    const failed = error !== null && typeof error === 'object' ? error : {}
    const code = 'status' in failed && typeof failed.status === 'number' ? failed.status : 1
    const stderr = 'stderr' in failed && typeof failed.stderr === 'string' ? failed.stderr.trim() : ''
    if (code === 2) return { ok: false, reason: 'bootstrap-refused-principal' }
    return {
      ok: false,
      reason: stderr.length > 0 ? `bootstrap-failed:${stderr.slice(0, 200)}` : `bootstrap-failed:${code}`,
    }
  }
}

function refusedBase(path: string): boolean {
  return path === '/wt' || path.endsWith('/wt')
}

function environmentWorktreeRoot(): string | { reason: string } | null {
  const env = process.env.OMP_WORKTREE_DIR
  if (typeof env !== 'string' || env.length === 0) return null
  return refusedBase(env) ? { reason: 'worktree-base-refused' } : env
}

function stackWorktreeBase(stack: unknown): string | null {
  if (stack === null || typeof stack !== 'object' || !('worktree' in stack)) return null
  const worktree = stack.worktree
  if (worktree === null || typeof worktree !== 'object' || !('base' in worktree)) return null
  return typeof worktree.base === 'string' ? worktree.base : null
}

function stackWorktreeRoot(principal: string, stackText: string | null): string | { reason: string } | null {
  if (stackText === null) return null
  const configuredBase = stackWorktreeBase(Bun.YAML.parse(stackText))
  if (configuredBase === null) return null
  const base = configuredBase.startsWith('/') ? configuredBase : join(principal, configuredBase)
  return refusedBase(base) ? { reason: 'worktree-base-refused' } : base
}

function worktreeRoot(principal: string, stackText: string | null): string | { reason: string } {
  const environmentRoot = environmentWorktreeRoot()
  if (environmentRoot !== null) return environmentRoot
  return stackWorktreeRoot(principal, stackText) ?? join(homedir(), '.omp/wt')
}

function existingCheckout(
  trees: Worktree[],
  wanted: string,
  principal: string,
  sessionTop: string,
): CheckoutPreparation | null {
  const existing = trees.find((tree) => tree.branch === wanted)
  if (existing === undefined) return null
  if (existing.path === principal) return { status: 'blocked', reason: 'checkout-refused-principal' }
  if (existing.path === sessionTop) return { status: 'ready', cwd: sessionTop, principal: false }
  return { status: 'move', path: existing.path, instruction: moveInstruction(existing.path) }
}

async function adoptedCheckout(
  git: GitRunner,
  sessionTop: string,
  wanted: string,
  principal: string,
): Promise<CheckoutPreparation | null> {
  const listed = await git(sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return { status: 'blocked', reason: 'worktree-list-unreadable' }
  return existingCheckout(parseWorktrees(listed.stdout), wanted, principal, sessionTop)
}

async function checkoutPath(
  git: GitRunner,
  principal: string,
  repository: string,
  branch: string,
): Promise<string | CheckoutPreparation> {
  const stack = await git(principal, ['show', 'HEAD:.dev/stack.yml'])
  const root = worktreeRoot(principal, stack.code === 0 ? stack.stdout : null)
  if (typeof root !== 'string') return { status: 'blocked', reason: root.reason }
  const repo = repository.split('/')[1]
  if (!repo) return { status: 'blocked', reason: 'repository-unreadable' }
  const path = join(root, repo, branch.replaceAll('/', '-'))
  return refusedBase(path) ? { status: 'blocked', reason: 'worktree-base-refused' } : path
}

async function addBranchFromBase(
  git: GitRunner,
  principal: string,
  input: { branch: string; base: string; detached: boolean },
  path: string,
): Promise<string | CheckoutPreparation> {
  const fetched = await git(principal, [
    'fetch',
    'origin',
    `+refs/heads/${input.base}:refs/remotes/origin/${input.base}`,
  ])
  if (fetched.code !== 0) return { status: 'blocked', reason: 'base-not-current' }
  const tip = await git(principal, ['rev-parse', '--verify', `refs/remotes/origin/${input.base}`])
  if (tip.code !== 0 || !SHA.test(tip.stdout.trim())) return { status: 'blocked', reason: 'base-not-current' }
  const args = input.detached
    ? ['worktree', 'add', '--detach', path, tip.stdout.trim()]
    : ['worktree', 'add', '-b', input.branch, path, tip.stdout.trim()]
  return String((await git(principal, args)).code)
}

async function addExistingBranch(
  git: GitRunner,
  principal: string,
  branch: string,
  path: string,
): Promise<string | CheckoutPreparation> {
  const fetched = await git(principal, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  if (fetched.code !== 0) return { status: 'blocked', reason: 'branch-not-current' }
  const tip = await git(principal, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
  const remoteTip = tip.stdout.trim()
  if (tip.code !== 0 || !SHA.test(remoteTip)) return { status: 'blocked', reason: 'branch-not-current' }
  const local = await git(principal, ['rev-parse', '--verify', `refs/heads/${branch}`])
  if (local.code === 0 && local.stdout.trim() !== remoteTip) return { status: 'blocked', reason: 'branch-not-current' }
  const args = local.code === 0 ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, remoteTip]
  return String((await git(principal, args)).code)
}

/**
 * Prepare a linked checkout. Never publishes a mandate, binding, or start,
 * and never relocates the session. `/wt` is refused. A failed add is re-read:
 * the branch another caller just created is that checkout, not a fresh failure.
 */
export async function prepareFeatureCheckout(input: {
  git: GitRunner
  sessionCwd: string
  branch: string
  base: string
  repository: string
  detached: boolean
  /** Attach the named branch at its fetched tip. Never create it from `base`. */
  attachExisting?: boolean
}): Promise<CheckoutPreparation> {
  const top = await input.git(input.sessionCwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { status: 'blocked', reason: 'session-not-a-worktree' }
  const sessionTop = top.stdout.trim()
  const listed = await input.git(sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return { status: 'blocked', reason: 'worktree-list-unreadable' }
  const trees = parseWorktrees(listed.stdout)
  const principal = trees[0]?.path
  if (!principal) return { status: 'blocked', reason: 'principal-unreadable' }
  const wanted = `refs/heads/${input.branch}`
  const existing = existingCheckout(trees, wanted, principal, sessionTop)
  if (existing) return existing
  const path = await checkoutPath(input.git, principal, input.repository, input.branch)
  if (typeof path !== 'string') return path
  const added = input.attachExisting
    ? await addExistingBranch(input.git, principal, input.branch, path)
    : await addBranchFromBase(input.git, principal, input, path)
  if (typeof added !== 'string') return added
  if (added !== '0') {
    const adopted = await adoptedCheckout(input.git, sessionTop, wanted, principal)
    return adopted ?? { status: 'blocked', reason: 'worktree-add-failed' }
  }
  return { status: 'move', path, instruction: moveInstruction(path) }
}
