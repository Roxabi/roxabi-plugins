import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { updateGitHubIssueBody } from '../adapters/github-adapter'
import { GitHubApiError } from '../domain/errors'

const previousToken = process.env.GITHUB_TOKEN

describe('updateGitHubIssueBody', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousToken
  })

  it('PATCHes the issue body on the same REST path create uses, including an empty body', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await updateGitHubIssueBody(362, '', 'Acme/app')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/Acme/app/issues/362',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: '' }),
      }),
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' })
  })

  it('defaults the repo to GITHUB_REPO', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await updateGitHubIssueBody(42, 'hello')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/Test/test-repo/issues/42',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ body: 'hello' }) }),
    )
  })

  it('throws when GitHub refuses the update', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }))
    await expect(updateGitHubIssueBody(42, 'hello', 'Acme/app')).rejects.toBeInstanceOf(GitHubApiError)
  })
})
