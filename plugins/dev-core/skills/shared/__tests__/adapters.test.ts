// TODO: Add behavioral tests with mocked Bun.spawnSync and fetch
import { describe, expect, it } from 'vitest'
import { EnvConfigAdapter } from '../adapters/env-config'
import { GitWorkspaceAdapter } from '../adapters/git-workspace'
import type { ConfigPort } from '../ports/config'
import type { WorkspacePort } from '../ports/workspace'

describe('EnvConfigAdapter', () => {
  it('implements ConfigPort', () => {
    const adapter: ConfigPort = new EnvConfigAdapter()
    expect(adapter).toBeDefined()
    expect(typeof adapter.getRepo).toBe('function')
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
    expect(typeof adapter.listBranches).toBe('function')
    expect(typeof adapter.listWorktrees).toBe('function')
  })
})
