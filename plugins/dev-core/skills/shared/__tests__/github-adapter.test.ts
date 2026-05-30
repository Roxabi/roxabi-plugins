/**
 * Error-class wiring tests for github-adapter (T3 — Slice 1 RED-GATE).
 * Proves that HTTP/GraphQL failures throw typed domain exceptions,
 * not bare Error instances.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GitHubApiError } from '../domain/errors'

// Stub fetch before importing the module (vi.stubGlobal not supported in Bun)
const origFetch = globalThis.fetch
const mockFetch = vi.fn()
;(globalThis as unknown as { fetch: unknown }).fetch = mockFetch

afterAll(() => {
  ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
})

// GITHUB_TOKEN set so getGitHubToken() resolves without spawning gh CLI
process.env.GITHUB_TOKEN = 'test-token'

const { ghGraphQL, getNodeId } = await import('../adapters/github-adapter')

describe('github-adapter error wiring', () => {
  describe('ghGraphQL — HTTP failure', () => {
    it('throws GitHubApiError with statusCode from response.status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      })

      let caught: unknown
      try {
        await ghGraphQL('query {}', {})
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(GitHubApiError)
      expect((caught as GitHubApiError).statusCode).toBe(503)
      expect((caught as GitHubApiError).message).toContain('GitHub GraphQL error (503)')
    })
  })

  describe('ghGraphQL — GraphQL application-level error (200 ok, errors array)', () => {
    it('throws GitHubApiError with undefined statusCode when response is ok but body has errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ errors: [{ message: 'field not found' }] }),
      })

      let caught: unknown
      try {
        await ghGraphQL('query {}', {})
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(GitHubApiError)
      expect((caught as GitHubApiError).statusCode).toBeUndefined()
      expect((caught as GitHubApiError).message).toContain('GitHub GraphQL error:')
    })
  })

  describe('getNodeId — HTTP failure', () => {
    it('throws GitHubApiError with statusCode from response.status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      })

      let caught: unknown
      try {
        await getNodeId(99)
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(GitHubApiError)
      expect((caught as GitHubApiError).statusCode).toBe(404)
      expect((caught as GitHubApiError).message).toContain('Failed to get node ID for #99 (404)')
    })
  })
})
