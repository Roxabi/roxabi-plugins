import { afterEach, expect, it, vi } from 'vitest'
import * as admission from '../feature-continuation-admission.ts'
import { readLiveFeatureMandate } from '../feature-live-mandate.ts'

afterEach(() => vi.restoreAllMocks())

it('refuses a former leaf whose current accepted Spec now commits a child', async () => {
  const scope = { repository: 'acme/app', target: 'acme/app#41' }
  const mandate = {
    recordId: 'original-leaf',
    payload: { role: 'feature', base: 'main', branch: 'feat/41', children: [], ownSpec: { uw: scope } },
  }
  const history = { source: { scope }, operations: [] }
  const accepted = { children: [] as { scope: typeof scope }[] }
  const resolveOwnSpecAuthority = vi.fn(() => ({ ok: true, value: { accepted, mandate } }))
  const git = vi.fn(async () => ({ code: 0, stdout: 'refs/heads/feat/41', stderr: '' }))
  vi.spyOn(admission, 'resolveFeatureAuthority').mockResolvedValue({
    target: { status: 'issue' },
    scope,
    selection: { status: 'applicable', mandate },
    history,
    parentHistories: [],
    causal: { histories: [history] },
    identity: { ok: true, onPrincipal: false },
    context: { engine: { resolveOwnSpecAuthority } },
  } as unknown as admission.FeatureAuthority)
  const input = { repository: scope.repository, issue: 41, mandate: mandate.recordId, cwd: '/work', git, gh: vi.fn() }
  await expect(readLiveFeatureMandate(input, true)).resolves.toMatchObject({ branch: 'feat/41' })
  accepted.children.push({ scope: { repository: scope.repository, target: 'acme/app#42' } })
  git.mockClear()
  await expect(readLiveFeatureMandate(input, true)).rejects.toThrow('parent-delivery-suspended')
  expect(git).not.toHaveBeenCalled()
})
