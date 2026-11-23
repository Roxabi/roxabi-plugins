import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Scope } from '../engine/record-values.ts'
import { failedGitResult } from './workflow-checkout-git-error.ts'
import { checkoutPath, parentCheckoutPath } from './workflow-checkout-path.ts'
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
const BOOTSTRAP_SCRIPT = fileURLToPath(new URL('../skills/feature/worktree-bootstrap.sh', import.meta.url))

export type CheckoutPreparation =
  | { status: 'ready'; cwd: string; principal: boolean }
  | { status: 'move'; path: string; instruction: `/move ${string}` }
  | { status: 'blocked'; reason: string }

export type FeatureCheckoutTarget =
  | { kind: 'parent'; uw: Scope }
  | { kind: 'branch'; branch: string; attachExisting?: true }

function moveInstruction<P extends string>(path: P): `/move ${P}` {
  return `/move ${path}`
}

export type SessionWorktreeIdentity =
  | { ok: true; sessionTop: string; principalTop: string; onPrincipal: boolean }
  | { ok: false; reason: string }

type Worktree = { path: string; branch: string | null; detached: boolean }

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

export async function verifyParentCheckout(input: {
  git: GitRunner
  cwd: string
  uw: Scope
}): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const identity = await sessionWorktreeIdentity(input.git, input.cwd)
  if (!identity.ok) return identity
  if (identity.onPrincipal) return { ok: false, reason: 'checkout-refused-principal' }
  const path = await parentCheckoutPath(input.git, identity.principalTop, input.uw)
  if (typeof path !== 'string') return { ok: false, reason: path.reason }
  const listed = await input.git(identity.sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return { ok: false, reason: 'worktree-list-unreadable' }
  const matches = parseWorktrees(listed.stdout).filter((tree) => samePath(tree.path, path))
  if (matches.length !== 1 || !samePath(identity.sessionTop, path))
    return { ok: false, reason: 'session-not-intended-worktree' }
  return { ok: true, cwd: identity.sessionTop }
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

async function addBranchFromBase(
  git: GitRunner,
  principal: string,
  input: { target: FeatureCheckoutTarget; base: string },
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
  const args =
    input.target.kind === 'parent'
      ? ['worktree', 'add', '--detach', path, tip.stdout.trim()]
      : ['worktree', 'add', '-b', input.target.branch, path, tip.stdout.trim()]
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

function findTargetCheckout(
  current: Worktree[],
  target: FeatureCheckoutTarget,
  principal: string,
  sessionTop: string,
  path: string,
): CheckoutPreparation | null {
  if (target.kind === 'branch') return existingCheckout(current, `refs/heads/${target.branch}`, principal, sessionTop)
  const matches = current.filter((tree) => samePath(tree.path, path))
  if (matches.length > 1) return { status: 'blocked', reason: 'parent-checkout-ambiguous' }
  const existing = matches[0]
  if (!existing) return null
  if (samePath(existing.path, principal)) return { status: 'blocked', reason: 'checkout-refused-principal' }
  return samePath(existing.path, sessionTop)
    ? { status: 'ready', cwd: sessionTop, principal: false }
    : { status: 'move', path: existing.path, instruction: moveInstruction(existing.path) }
}

async function validateTargetCheckout(
  result: CheckoutPreparation | null,
  target: FeatureCheckoutTarget,
  git: GitRunner,
  principal: string,
): Promise<CheckoutPreparation | null> {
  if (result === null || result.status === 'blocked' || target.kind !== 'parent') return result
  const cwd = result.status === 'ready' ? result.cwd : result.path
  const identity = await sessionWorktreeIdentity(git, cwd)
  if (!identity.ok || !samePath(identity.principalTop, principal))
    return { status: 'blocked', reason: 'parent-checkout-unreadable' }
  const verified = await verifyParentCheckout({ git, cwd, uw: target.uw })
  if (!verified.ok) return { status: 'blocked', reason: verified.reason }
  const branch = await git(cwd, ['branch', '--show-current'])
  if (branch.code !== 0) return { status: 'blocked', reason: 'parent-checkout-unreadable' }
  if (branch.stdout.trim() !== '') {
    const status = await git(cwd, ['status', '--porcelain'])
    if (status.code !== 0 || status.stdout.trim() !== '')
      return { status: 'blocked', reason: 'parent-checkout-active-dirty' }
  }
  return result
}

/** Prepare the requested registered checkout without relocating the session. */
export async function prepareFeatureCheckout(input: {
  git: GitRunner
  sessionCwd: string
  target: FeatureCheckoutTarget
  base: string
  repository: string
}): Promise<CheckoutPreparation> {
  const top = await input.git(input.sessionCwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { status: 'blocked', reason: 'session-not-a-worktree' }
  const sessionTop = top.stdout.trim()
  const listed = await input.git(sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return { status: 'blocked', reason: 'worktree-list-unreadable' }
  const trees = parseWorktrees(listed.stdout)
  const principal = trees[0]?.path
  if (!principal) return { status: 'blocked', reason: 'principal-unreadable' }
  const { target } = input
  if (target.kind === 'parent' && target.uw.repository !== input.repository)
    return { status: 'blocked', reason: 'repository-mismatch' }
  if (target.kind === 'branch') {
    const existing = existingCheckout(trees, `refs/heads/${target.branch}`, principal, sessionTop)
    if (existing) return existing
  }
  const path = await targetCheckoutPath(input, principal)
  if (typeof path !== 'string') return path
  const existing = await validateTargetCheckout(
    findTargetCheckout(trees, target, principal, sessionTop, path),
    target,
    input.git,
    principal,
  )
  if (existing) return existing
  const added = await addTargetCheckout(input, principal, path)
  if (typeof added !== 'string') return added
  if (added !== '0') {
    const listedAgain = await input.git(sessionTop, ['worktree', 'list', '--porcelain'])
    if (listedAgain.code !== 0) return { status: 'blocked', reason: 'worktree-list-unreadable' }
    return (
      (await validateTargetCheckout(
        findTargetCheckout(parseWorktrees(listedAgain.stdout), target, principal, sessionTop, path),
        target,
        input.git,
        principal,
      )) ?? {
        status: 'blocked',
        reason: 'worktree-add-failed',
      }
    )
  }
  return { status: 'move', path, instruction: moveInstruction(path) }
}

async function targetCheckoutPath(input: Parameters<typeof prepareFeatureCheckout>[0], principal: string) {
  return input.target.kind === 'parent'
    ? parentCheckoutPath(input.git, principal, input.target.uw)
    : checkoutPath(input.git, principal, input.repository, input.target.branch)
}

async function addTargetCheckout(input: Parameters<typeof prepareFeatureCheckout>[0], principal: string, path: string) {
  return input.target.kind === 'branch' && input.target.attachExisting
    ? addExistingBranch(input.git, principal, input.target.branch, path)
    : addBranchFromBase(input.git, principal, input, path)
}
