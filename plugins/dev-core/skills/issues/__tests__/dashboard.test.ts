import { describe, expect, it } from 'vitest'
import { toWorkspaceProject } from '../lib/workspace-helpers'

describe('toWorkspaceProject', () => {
  it('preserves localPath (regression: single-project path dropped it)', () => {
    const input = {
      label: 'my-project',
      repo: 'owner/repo',
      projectId: 'PVT_123',
      type: 'technical' as const,
      fieldIds: undefined,
      vercelProjects: [],
      localPath: '/some/path',
    }
    const result = toWorkspaceProject(input)
    expect(result.localPath).toBe('/some/path')
  })

  it('maps all WorkspaceProject fields', () => {
    const input = {
      label: 'proj',
      repo: 'owner/repo',
      projectId: 'PVT_456',
      type: 'company' as const,
      fieldIds: { status: 'f1', size: 'f2', priority: 'f3' } as never,
      vercelProjects: [{ projectId: 'vp1', teamId: 'team1' }],
      localPath: '/home/user/projects/repo',
    }
    const result = toWorkspaceProject(input)
    expect(result.label).toBe('proj')
    expect(result.repo).toBe('owner/repo')
    expect(result.projectId).toBe('PVT_456')
    expect(result.type).toBe('company')
    expect(result.vercelProjects).toEqual([{ projectId: 'vp1', teamId: 'team1' }])
    expect(result.localPath).toBe('/home/user/projects/repo')
  })

  it('handles missing optional fields gracefully', () => {
    const input = {
      label: 'minimal',
      repo: 'owner/repo',
      projectId: 'PVT_789',
    }
    const result = toWorkspaceProject(input as never)
    expect(result.label).toBe('minimal')
    expect(result.localPath).toBeUndefined()
    expect(result.vercelProjects).toBeUndefined()
  })
})
