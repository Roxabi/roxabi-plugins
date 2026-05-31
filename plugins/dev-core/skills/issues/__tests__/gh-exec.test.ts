import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWriteFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockExecSync = vi.fn()

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}))

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}))

// Import AFTER mocks are established
const { ghGraphQLExec } = await import('../lib/gh-exec')

describe('ghGraphQLExec', () => {
  beforeEach(() => {
    mockWriteFileSync.mockClear()
    mockUnlinkSync.mockClear()
    mockExecSync.mockClear()
    mockExecSync.mockReturnValue(JSON.stringify({ data: {} }))
  })

  it('writes payload without variables property when no variables provided', () => {
    const query = 'query { viewer { login } }'
    ghGraphQLExec(query)

    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [, rawPayload] = mockWriteFileSync.mock.calls[0] as [string, string]
    const payload = JSON.parse(rawPayload)
    expect(payload).toEqual({ query })
    expect(Object.hasOwn(payload, 'variables')).toBe(false)
  })

  it('writes payload with variables when variables are provided', () => {
    const query = 'query($owner: String!) { repository(owner: $owner) { id } }'
    const variables = { owner: 'Roxabi', repo: 'roxabi-plugins', number: 42 }
    ghGraphQLExec(query, variables)

    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [, rawPayload] = mockWriteFileSync.mock.calls[0] as [string, string]
    const payload = JSON.parse(rawPayload)
    expect(payload).toEqual({ query, variables })
  })

  it('writes payload without variables property when variables is undefined', () => {
    const query = '{ viewer { login } }'
    ghGraphQLExec(query, undefined)

    const [, rawPayload] = mockWriteFileSync.mock.calls[0] as [string, string]
    const payload = JSON.parse(rawPayload)
    expect(Object.hasOwn(payload, 'variables')).toBe(false)
  })

  it('returns the parsed JSON from execSync output', () => {
    const expected = { data: { viewer: { login: 'octocat' } } }
    mockExecSync.mockReturnValue(JSON.stringify(expected))
    const result = ghGraphQLExec('{ viewer { login } }')
    expect(result).toEqual(expected)
  })

  it('calls unlinkSync to clean up the temp file even when execSync succeeds', () => {
    ghGraphQLExec('{ viewer { login } }')
    expect(mockUnlinkSync).toHaveBeenCalledOnce()
    // tmp file path passed to writeFileSync and unlinkSync must match
    const writePath = (mockWriteFileSync.mock.calls[0] as [string, string])[0]
    const unlinkPath = (mockUnlinkSync.mock.calls[0] as [string])[0]
    expect(writePath).toBe(unlinkPath)
  })
})
