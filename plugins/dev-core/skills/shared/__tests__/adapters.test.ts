// TODO: Add behavioral tests with mocked Bun.spawnSync and fetch
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvConfigAdapter } from '../adapters/env-config'
import { GitWorkspaceAdapter } from '../adapters/git-workspace'
import type { ConfigPort } from '../ports/config'
import type { WorkspacePort } from '../ports/workspace'

const discoverProjectFn = vi.hoisted(() => vi.fn(async () => []))
vi.mock('../adapters/github-discovery', () => ({ discoverProject: discoverProjectFn }))

describe('EnvConfigAdapter', () => {
  it('implements ConfigPort', () => {
    const adapter: ConfigPort = new EnvConfigAdapter()
    expect(adapter).toBeDefined()
    expect(typeof adapter.getRepo).toBe('function')
    expect(typeof adapter.getProjectId).toBe('function')
    expect(typeof adapter.getFieldMap).toBe('function')
    expect(typeof adapter.resolveFieldIds).toBe('function')
    expect(typeof adapter.isProjectConfigured).toBe('function')
    expect(typeof adapter.resolveStatus).toBe('function')
    expect(typeof adapter.resolvePriority).toBe('function')
    expect(typeof adapter.resolveSize).toBe('function')
  })
})

describe('GitWorkspaceAdapter', () => {
  it('implements WorkspacePort', () => {
    const adapter: WorkspacePort = new GitWorkspaceAdapter()
    expect(adapter).toBeDefined()
    expect(typeof adapter.readWorkspace).toBe('function')
    expect(typeof adapter.writeWorkspace).toBe('function')
    expect(typeof adapter.discoverProject).toBe('function')
    expect(typeof adapter.listBranches).toBe('function')
    expect(typeof adapter.listWorktrees).toBe('function')
  })

  describe('discoverProject', () => {
    beforeEach(() => discoverProjectFn.mockClear())

    it('forwards localPath to the shared discoverProject', async () => {
      const adapter = new GitWorkspaceAdapter()
      await adapter.discoverProject('Roxabi/roxabi-plugins', '/home/me/clone')
      expect(discoverProjectFn).toHaveBeenCalledWith('Roxabi/roxabi-plugins', '/home/me/clone')
    })

    it('forwards undefined (never an injected path) when the caller omits localPath', async () => {
      const adapter = new GitWorkspaceAdapter()
      await adapter.discoverProject('Roxabi/roxabi-plugins')
      // toStrictEqual on the exact call args (vs toHaveBeenCalledWith) guards against
      // a regression that re-injects a detected path — e.g. discoverProjectFn(repo, detectLocalPath(repo)) —
      // which would re-introduce the shared->cli coupling #219 removed.
      expect(discoverProjectFn.mock.lastCall).toStrictEqual(['Roxabi/roxabi-plugins', undefined])
    })
  })
})
