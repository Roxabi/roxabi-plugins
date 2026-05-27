import { describe, expect, it } from 'vitest'
import { ConfigError, DevCoreError, GitHubApiError, WorkspaceError } from '../domain/errors'
import type { Issue, PR, SubIssue } from '../domain/types'
import type { ConfigPort } from '../ports/config'
import type { IssuePort } from '../ports/issue'
import type { ProjectPort } from '../ports/project'
import type { WorkspacePort } from '../ports/workspace'

describe('domain/types', () => {
  it('Issue interface is assignable', () => {
    const issue: Issue = {
      number: 1,
      title: 'Test',
      url: 'https://github.com/test/repo/issues/1',
      state: 'OPEN',
      status: 'Backlog',
      size: null,
      priority: null,
      labels: [],
      assignees: [],
      children: [],
    }
    expect(issue.number).toBe(1)
  })

  it('PR interface is assignable', () => {
    const pr: PR = {
      number: 1,
      title: 'Test PR',
      branch: 'feat/test',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/test/repo/pull/1',
      author: 'user',
      updatedAt: '2026-01-01',
      additions: 10,
      deletions: 5,
      reviewDecision: '',
      labels: [],
      mergeable: 'MERGEABLE',
      checks: [],
    }
    expect(pr.branch).toBe('feat/test')
  })

  it('SubIssue interface is assignable', () => {
    const sub: SubIssue = { number: 2, state: 'OPEN', title: 'Sub' }
    expect(sub.number).toBe(2)
  })
})

describe('domain/errors', () => {
  it('DevCoreError hierarchy', () => {
    expect(new GitHubApiError('fail')).toBeInstanceOf(DevCoreError)
    expect(new ConfigError('bad config')).toBeInstanceOf(DevCoreError)
    expect(new WorkspaceError('no workspace')).toBeInstanceOf(DevCoreError)
  })

  it('GitHubApiError carries status code', () => {
    const err = new GitHubApiError('Not found', 404)
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Not found')
  })
})

describe('port interfaces are importable', () => {
  it('IssuePort type exists', () => {
    // Type-level check — if this compiles, the port interface exists
    const _check: IssuePort | null = null
    expect(_check).toBeNull()
  })

  it('ProjectPort type exists', () => {
    const _check: ProjectPort | null = null
    expect(_check).toBeNull()
  })

  it('WorkspacePort type exists', () => {
    const _check: WorkspacePort | null = null
    expect(_check).toBeNull()
  })

  it('ConfigPort type exists', () => {
    const _check: ConfigPort | null = null
    expect(_check).toBeNull()
  })
})
