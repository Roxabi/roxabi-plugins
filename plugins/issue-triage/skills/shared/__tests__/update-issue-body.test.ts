import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateIssueBody } from '../adapters/github-adapter'

describe('updateIssueBody', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture')
    vi.stubGlobal('fetch', vi.fn())
  })

  it('PATCHes the body, including an empty string, and does not GET', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await updateIssueBody(42, '', 'Acme/app')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.github.com/repos/Acme/app/issues/42')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ body: '' })
  })

  it('names the status, the issue and the response text when the PATCH is rejected', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('nope', { status: 422 }))
    await expect(updateIssueBody(42, 'NEW', 'Acme/app')).rejects.toThrow(/422/)
    await expect(updateIssueBody(42, 'NEW', 'Acme/app')).rejects.toThrow(/#42/)
    await expect(updateIssueBody(42, 'NEW', 'Acme/app')).rejects.toThrow(/Acme\/app/)
    await expect(updateIssueBody(42, 'NEW', 'Acme/app')).rejects.toThrow(/nope/)
  })
})
