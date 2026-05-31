import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWriteFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockSpawnSync = vi.fn()

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}))

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}))

// Import AFTER mocks are established
const { ghGraphQLExec } = await import('../lib/gh-exec')

describe('ghGraphQLExec', () => {
  beforeEach(() => {
    mockWriteFileSync.mockClear()
    mockUnlinkSync.mockClear()
    mockSpawnSync.mockClear()
    mockSpawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ data: {} }), stderr: '' })
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

  it('writes payload without variables property when variables is an empty object', () => {
    const query = '{ viewer { login } }'
    ghGraphQLExec(query, {})

    const [, rawPayload] = mockWriteFileSync.mock.calls[0] as [string, string]
    const payload = JSON.parse(rawPayload)
    expect(Object.hasOwn(payload, 'variables')).toBe(false)
  })

  it('returns the parsed JSON from spawnSync output', () => {
    const expected = { data: { viewer: { login: 'octocat' } } }
    mockSpawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(expected), stderr: '' })
    const result = ghGraphQLExec('{ viewer { login } }')
    expect(result).toEqual(expected)
  })

  it('calls unlinkSync to clean up the temp file even when spawnSync succeeds', () => {
    ghGraphQLExec('{ viewer { login } }')
    expect(mockUnlinkSync).toHaveBeenCalledOnce()
    // tmp file path passed to writeFileSync and unlinkSync must match
    const writePath = (mockWriteFileSync.mock.calls[0] as [string, string])[0]
    const unlinkPath = (mockUnlinkSync.mock.calls[0] as [string])[0]
    expect(writePath).toBe(unlinkPath)
  })

  it('throws when spawnSync returns non-zero status AND still calls unlinkSync (finally guarantee)', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stderr: 'boom', stdout: '' })

    expect(() => ghGraphQLExec('{ viewer { login } }')).toThrow('gh api graphql failed: boom')
    expect(mockUnlinkSync).toHaveBeenCalledOnce()
    // unlink path matches write path even on failure
    const writePath = (mockWriteFileSync.mock.calls[0] as [string, string])[0]
    const unlinkPath = (mockUnlinkSync.mock.calls[0] as [string])[0]
    expect(writePath).toBe(unlinkPath)
  })
})
