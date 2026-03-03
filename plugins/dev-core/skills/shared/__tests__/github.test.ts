import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub fetch before importing the module (vi.stubGlobal not supported in Bun)
const mockFetch = vi.fn()
;(globalThis as unknown as { fetch: unknown }).fetch = mockFetch

// Set GITHUB_TOKEN for tests
process.env.GITHUB_TOKEN = 'test-token'

const { ghGraphQL, run } = await import('../github')

function mockProcess(stdout: string, stderr = '', exitCode = 0) {
  const stdoutStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout))
      controller.close()
    },
  })
  const stderrStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stderr))
      controller.close()
    },
  })
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
  }
}

describe('shared/github', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Spy on Bun.spawn (vi.stubGlobal not supported in Bun's compat layer)
    spawnSpy = vi.spyOn(Bun, 'spawn')
    spawnSpy.mockReset()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('run', () => {
    it('returns trimmed stdout', async () => {
      spawnSpy.mockReturnValue(mockProcess('  hello world  \n') as ReturnType<typeof Bun.spawn>)
      const result = await run(['echo', 'hello'])
      expect(result).toBe('hello world')
    })

    it('passes command to Bun.spawn', async () => {
      spawnSpy.mockReturnValue(mockProcess('ok') as ReturnType<typeof Bun.spawn>)
      await run(['git', 'status'])
      expect(spawnSpy).toHaveBeenCalledWith(
        ['git', 'status'],
        expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' }),
      )
    })

    it('throws on non-zero exit code', async () => {
      spawnSpy.mockReturnValue(mockProcess('', 'not found', 1) as ReturnType<typeof Bun.spawn>)
      await expect(run(['git', 'branch'])).rejects.toThrow('Command failed (1)')
    })
  })

  describe('ghGraphQL', () => {
    it('calls GitHub GraphQL API with correct headers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      })
      await ghGraphQL('query { viewer { login } }', { owner: 'test' })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/graphql',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      )
    })

    it('passes variables in request body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      })
      await ghGraphQL('query { issue(number: $number) { id } }', { number: 42 })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.variables.number).toBe(42)
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      })
      await expect(ghGraphQL('query {}', {})).rejects.toThrow('GitHub GraphQL error (401)')
    })

    it('throws on GraphQL errors', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errors: [{ message: 'Not found' }] }),
      })
      await expect(ghGraphQL('query {}', {})).rejects.toThrow('GitHub GraphQL error')
    })

    it('parses JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { viewer: { login: 'test' } } }),
      })
      const result = (await ghGraphQL('query { viewer { login } }', {})) as {
        data: { viewer: { login: string } }
      }
      expect(result.data.viewer.login).toBe('test')
    })
  })
})
