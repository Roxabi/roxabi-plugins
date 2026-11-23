import { afterEach, expect, it, vi } from 'vitest'
import * as admission from '../feature-continuation-admission.ts'
import { readLiveFeatureMandate } from '../feature-live-mandate.ts'

afterEach(() => vi.restoreAllMocks())

const scope = { repository: 'acme/app', target: 'acme/app#41' }
const child = { repository: scope.repository, target: 'acme/app#42' }

it.each([
  ['accepted child', 'parent-delivery-suspended'],
  ['unaccepted native child', 'parent-delivery-suspended'],
  ['accepted Spec resolution failure', 'leaf-status-unknown'],
  ['native child projection failure', 'leaf-status-unknown'],
] as const)('refuses delivery after %s', async (change, reason) => {
  const mandate = {
    recordId: 'original-leaf',
    payload: { role: 'feature', base: 'main', branch: 'feat/41', children: [], ownSpec: { uw: scope } },
  }
  const history = { source: { scope }, operations: [] }
  const accepted = { children: [] as { scope: typeof scope }[] }
  const root = { uw: scope, children: [] as (typeof scope)[], labels: [] }
  const graph = { status: 'complete', nodes: [root, { uw: child, children: [], labels: [] }] }
  const resolveOwnSpecAuthority = vi.fn<() => { ok: false } | { ok: true; value: { accepted: typeof accepted } }>(
    () => ({ ok: true, value: { accepted } }),
  )
  const git = vi.fn(async () => ({ code: 0, stdout: 'refs/heads/feat/41', stderr: '' }))
  vi.spyOn(admission, 'resolveFeatureAuthority').mockResolvedValue({
    target: { status: 'issue' },
    scope,
    selection: { status: 'applicable', mandate },
    history,
    parentHistories: [],
    causal: { histories: [history], observation: { graph } },
    identity: { ok: true, onPrincipal: false },
    context: { engine: { resolveOwnSpecAuthority } },
  } as unknown as admission.FeatureAuthority)
  const input = { repository: scope.repository, issue: 41, mandate: mandate.recordId, cwd: '/work', git, gh: vi.fn() }
  await expect(readLiveFeatureMandate(input, true)).resolves.toMatchObject({ branch: 'feat/41' })
  git.mockClear()
  if (change === 'accepted Spec resolution failure') resolveOwnSpecAuthority.mockReturnValue({ ok: false })
  if (change === 'accepted child') accepted.children.push({ scope: child })
  if (change === 'unaccepted native child') root.children.push(child)
  if (change === 'native child projection failure') graph.nodes.splice(0, 1)
  await expect(readLiveFeatureMandate(input, true)).rejects.toThrow(reason)
  expect(git).not.toHaveBeenCalled()
  await expect(readLiveFeatureMandate(input, false)).rejects.toThrow(reason)
})
