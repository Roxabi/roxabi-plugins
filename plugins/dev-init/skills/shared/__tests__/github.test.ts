import { vi } from 'vitest'
import { registerGithubSuite } from '../../../../shared/__tests__/github.suite'

const mockFetch = vi.fn()
;(globalThis as unknown as { fetch: unknown }).fetch = mockFetch
process.env.GITHUB_TOKEN = 'test-token'

const { ghGraphQL, run } = await import('../adapters/github-adapter')

registerGithubSuite({ ghGraphQL, run, mockFetch })
