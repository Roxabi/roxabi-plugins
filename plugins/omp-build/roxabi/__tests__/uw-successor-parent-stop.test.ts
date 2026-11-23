import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveFeatureAuthority } from '../feature-continuation-admission.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { reframedParent } from './uw-successor-parent-fixtures.ts'
import { scope } from './uw-successor-selection-support.ts'

const bootstrap = vi.hoisted(() => vi.fn())
vi.mock('../workflow-checkout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow-checkout.ts')>()),
  runWorktreeBootstrap: async () => {
    bootstrap()
    return { ok: true }
  },
}))
beforeEach(() => {
  vi.stubEnv('OMP_WORKTREE_DIR', '/fixture-worktrees')
  bootstrap.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test.each([false, true])('a reframed Parent cannot start a successor (principal: %s)', async (principal) => {
  const subject = await reframedParent()
  if (principal) {
    subject.gitReplies.set('rev-parse --show-toplevel', '/principal')
    subject.gitReplies.set('branch --show-current', 'main')
  }
  const git = vi.fn(subject.authority.context.git)
  const authority = await resolveFeatureAuthority({
    cwd: principal ? '/principal' : subject.authority.context.cwd,
    reference: scope.target,
    control: 'new',
    principal,
    git,
    gh: subject.authority.context.gh,
    read: subject.reader,
  })
  const result =
    'kind' in authority ? authority : await selectFeatureMandate('new', undefined, authority, undefined, subject.reader)
  expect(result).toEqual({ kind: 'blocked', reason: 'parent-delivery-suspended' })
  expect(subject.native.writes).toEqual([])
  expect(bootstrap).not.toHaveBeenCalled()
  expect(git.mock.calls.map(([, args]) => args[0])).not.toContain('fetch')
  expect(git.mock.calls.map(([, args]) => args.slice(0, 2))).not.toContainEqual(['worktree', 'add'])
})
