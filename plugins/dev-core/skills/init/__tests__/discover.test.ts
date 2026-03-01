import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../shared/prereqs', () => ({
  checkPrereqs: vi.fn(),
}))

vi.mock('../../shared/github', () => ({
  run: vi.fn(),
}))

describe('discover', () => {
  let mockCheckPrereqs: ReturnType<typeof vi.fn>
  let mockRun: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    const prereqs = await import('../../shared/prereqs')
    const github = await import('../../shared/github')
    mockCheckPrereqs = prereqs.checkPrereqs as ReturnType<typeof vi.fn>
    mockRun = github.run as ReturnType<typeof vi.fn>

    const fs = require('fs')
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT') })
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  })

  it('returns empty result when gh is not available', async () => {
    mockCheckPrereqs.mockReturnValue({
      bun: { ok: true, version: '1.2.0' },
      gh: { ok: false, detail: 'not installed' },
      gitRemote: { ok: true, url: 'git@github.com:Org/repo.git', owner: 'Org', repo: 'repo' },
    })

    const { discover } = await import('../lib/discover')
    const result = await discover()
    expect(result.projects).toEqual([])
    expect(result.labels.existing).toEqual([])
  })

  it('discovers projects and labels when gh is available', async () => {
    mockCheckPrereqs.mockReturnValue({
      bun: { ok: true, version: '1.2.0' },
      gh: { ok: true, detail: 'authenticated' },
      gitRemote: { ok: true, url: 'git@github.com:Org/repo.git', owner: 'Org', repo: 'repo' },
    })

    mockRun.mockImplementation(async (cmd: string[]) => {
      const joined = cmd.join(' ')
      if (joined.includes('project list')) return JSON.stringify({ projects: [{ id: 'PVT_1', number: 1, title: 'Board' }] })
      if (joined.includes('label list')) return JSON.stringify([{ name: 'bug' }, { name: 'feature' }])
      if (joined.includes('branches') && joined.includes('protection')) throw new Error('404')
      return '{}'
    })

    const { discover } = await import('../lib/discover')
    const result = await discover()
    expect(result.projects).toHaveLength(1)
    expect(result.labels.existing).toEqual(['bug', 'feature'])
    expect(result.labels.missing.length).toBeGreaterThan(0)
  })

  it('returns null owner when git remote is missing', async () => {
    mockCheckPrereqs.mockReturnValue({
      bun: { ok: true, version: '1.2.0' },
      gh: { ok: true, detail: 'authenticated' },
      gitRemote: { ok: false, url: '', owner: '', repo: '' },
    })

    const { discover } = await import('../lib/discover')
    const result = await discover()
    expect(result.owner).toBeNull()
    expect(result.repo).toBeNull()
  })
})
