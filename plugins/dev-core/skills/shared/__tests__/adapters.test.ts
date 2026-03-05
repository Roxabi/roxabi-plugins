// TODO: Add behavioral tests with mocked Bun.spawnSync and fetch
import { describe, expect, it } from 'vitest'
import { EnvConfigAdapter } from '../adapters/env-config'
import { GitWorkspaceAdapter } from '../adapters/git-workspace'
import { GitHubAdapter } from '../adapters/github-adapter'
import type { ConfigPort } from '../ports/config'
import type { IssuePort } from '../ports/issue'
import type { ProjectPort } from '../ports/project'
import type { WorkspacePort } from '../ports/workspace'

describe('GitHubAdapter', () => {
  it('implements IssuePort', () => {
    const adapter: IssuePort = new GitHubAdapter('owner/repo')
    expect(adapter).toBeDefined()
    expect(typeof adapter.getIssue).toBe('function')
    expect(typeof adapter.listIssues).toBe('function')
    expect(typeof adapter.getNodeId).toBe('function')
    expect(typeof adapter.createIssue).toBe('function')
    expect(typeof adapter.updateLabels).toBe('function')
    expect(typeof adapter.addComment).toBe('function')
    expect(typeof adapter.getParentNumber).toBe('function')
  })

  it('implements ProjectPort', () => {
    const adapter: ProjectPort = new GitHubAdapter('owner/repo', 'PVT_123')
    expect(adapter).toBeDefined()
    expect(typeof adapter.getItemId).toBe('function')
    expect(typeof adapter.addToProject).toBe('function')
    expect(typeof adapter.updateField).toBe('function')
    expect(typeof adapter.addBlockedBy).toBe('function')
    expect(typeof adapter.removeBlockedBy).toBe('function')
    expect(typeof adapter.addSubIssue).toBe('function')
    expect(typeof adapter.removeSubIssue).toBe('function')
    expect(typeof adapter.linkProjectToRepo).toBe('function')
    expect(typeof adapter.getBoardIssueNumbers).toBe('function')
  })
})

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
})
