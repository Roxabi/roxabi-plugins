import { afterEach, describe, expect, it, vi } from 'vitest'

// The trunk resolvability guard (#375) on the REST writer. `pushWorkflows` refuses
// to push a trunk auto-release.yml unless the baked `run:` target
// (plugins/dev-core/skills/promote/auto-release.sh) is present on the target ref —
// otherwise the workflow dies exit 127 at its first release. The guard reuses the
// contents API the pusher already speaks, so it is exercised here with a mocked
// `run` (token source) and a stubbed global fetch.

vi.mock('../adapters/github-adapter', () => ({
  run: vi.fn(async () => 'fake-token'),
}))

import { pushWorkflows } from '../workflows/workflow-push'

const SCRIPT = 'plugins/dev-core/skills/promote/auto-release.sh'
const trunk = {
  stack: 'bun',
  test: 'vitest',
  deploy: 'none',
  release: { model: 'trunk', component: 'roxabi-plugins' },
} as const

const origFetch = globalThis.fetch
afterEach(() => {
  ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
  vi.restoreAllMocks()
})

describe('pushWorkflows — trunk resolvability guard (#375)', () => {
  it('REFUSES before pushing anything when auto-release.sh is absent on the target ref', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { method?: string }) => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    await expect(pushWorkflows('acme', 'consumer', trunk, 'main')).rejects.toThrow(/not resolvable/)

    // The refusal precedes the write loop: exactly one call — the guard's contents
    // GET for the script — and never a PUT of any workflow file. Without the guard,
    // pushWorkflows would GET+PUT every file in the set.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/contents/${SCRIPT}`)
    expect(String(url)).toContain('ref=main')
    expect((init as { method?: string } | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('proceeds past the guard when auto-release.sh is present (200)', async () => {
    // Guard GET → 200; then each file: GET (checkRes, 404 → treat as new) → PUT (201).
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (String(url).includes(`/contents/${SCRIPT}`)) return { ok: true, status: 200, json: async () => ({}) }
      if (init?.method === 'PUT') return { ok: true, status: 201, json: async () => ({}) }
      return { ok: false, status: 404, json: async () => ({}) } // checkRes: file absent → create
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const results = await pushWorkflows('acme', 'consumer', trunk, 'main')

    expect(results.some((r) => r.file === 'auto-release.yml' && r.status === 'created')).toBe(true)
    // The guard GET happened, and PUTs followed (so the guard did not short-circuit a valid push).
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes(`/contents/${SCRIPT}`))).toBe(true)
    expect(fetchMock.mock.calls.some(([, i]) => (i as { method?: string } | undefined)?.method === 'PUT')).toBe(true)
  })

  it('staging-train never triggers the guard (no script GET)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return { ok: true, status: 201, json: async () => ({}) }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    await pushWorkflows('acme', 'consumer', { stack: 'bun', test: 'vitest', deploy: 'none' }, 'main')

    // No auto-release.yml in the set, and the guard is skipped, so the script path
    // is never requested.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes(`/contents/${SCRIPT}`))).toBe(false)
  })
})
