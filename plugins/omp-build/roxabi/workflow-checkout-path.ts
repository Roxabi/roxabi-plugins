import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Scope } from '../engine/record-values.ts'
import type { CheckoutPreparation, GitRunner } from './workflow-checkout.ts'

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
export async function checkoutPath(
  git: GitRunner,
  principal: string,
  repository: string,
  name: string,
  parent = false,
): Promise<string | Extract<CheckoutPreparation, { status: 'blocked' }>> {
  const stack = await git(principal, ['show', 'HEAD:.dev/stack.yml'])
  const root = worktreeRoot(principal, stack.code === 0 ? stack.stdout : null)
  if (typeof root !== 'string') return { status: 'blocked', reason: root.reason }
  const repo = repository.split('/')[1]
  if (!repo) return { status: 'blocked', reason: 'repository-unreadable' }
  const path = parent ? join(root, repo, 'parents', name) : join(root, repo, name.replaceAll('/', '-'))
  return refusedBase(path) ? { status: 'blocked', reason: 'worktree-base-refused' } : path
}
export async function parentCheckoutPath(
  git: GitRunner,
  principal: string,
  uw: Scope,
): Promise<string | Extract<CheckoutPreparation, { status: 'blocked' }>> {
  const parts = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(uw.repository)
  const number = uw.target.startsWith(`${uw.repository}#`) ? uw.target.slice(uw.repository.length + 1) : ''
  if (
    !parts ||
    parts[2] === '.' ||
    parts[2] === '..' ||
    !/^[1-9][0-9]*$/.test(number) ||
    !Number.isSafeInteger(Number(number))
  ) {
    return { status: 'blocked', reason: 'parent-scope-invalid' }
  }
  try {
    const path = await checkoutPath(git, principal, uw.repository, `${parts[1]}-${number}`, true)
    return typeof path === 'string' ? resolve(principal, path) : path
  } catch {
    return { status: 'blocked', reason: 'worktree-base-unreadable' }
  }
}
