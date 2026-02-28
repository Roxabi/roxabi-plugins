import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock fetch and Bun.spawn/spawnSync before importing the module
const mockFetch = vi.fn()
const mockSpawn = vi.fn()
const mockSpawnSync = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.stubGlobal('Bun', {
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
})

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
  beforeEach(() => {
    mockSpawn.mockReset()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('run', () => {
    it('returns trimmed stdout', async () => {
      mockSpawn.mockReturnValue(mockProcess('  hello world  \n'))
      const result = await run(['echo', 'hello'])
      expect(result).toBe('hello world')
    })

    it('passes command to Bun.spawn', async () => {
      mockSpawn.mockReturnValue(mockProcess('ok'))
      await run(['git', 'status'])
      expect(mockSpawn).toHaveBeenCalledWith(
        ['git', 'status'],
        expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
      )
    })

    it('throws on non-zero exit code', async () => {
      mockSpawn.mockReturnValue(mockProcess('', 'not found', 1))
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
        })
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
