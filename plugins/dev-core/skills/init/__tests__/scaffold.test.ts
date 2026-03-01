import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mergeEnv } from '../lib/scaffold'

describe('mergeEnv', () => {
  const baseSections = [
    {
      header: '# --- dev-core: GitHub Project V2 ---',
      vars: [
        { key: 'GITHUB_REPO', value: 'Org/repo' },
        { key: 'PROJECT_ID', value: 'PVT_123' },
      ],
    },
  ]

  it('writes dev-core section to empty .env', () => {
    const result = mergeEnv('', baseSections, false)
    expect(result).toContain('GITHUB_REPO=Org/repo')
    expect(result).toContain('PROJECT_ID=PVT_123')
    expect(result).toContain('# --- dev-core: GitHub Project V2 ---')
  })

  it('preserves non-dev-core lines', () => {
    const existing = 'MY_VAR=hello\nOTHER=world\n'
    const result = mergeEnv(existing, baseSections, false)
    expect(result).toContain('MY_VAR=hello')
    expect(result).toContain('OTHER=world')
    expect(result).toContain('GITHUB_REPO=Org/repo')
  })

  it('replaces existing dev-core block', () => {
    const existing = 'MY_VAR=hello\n# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=Old/repo\nPROJECT_ID=PVT_old\n\nOTHER=world\n'
    const result = mergeEnv(existing, baseSections, true)
    expect(result).toContain('GITHUB_REPO=Org/repo')
    expect(result).not.toContain('Old/repo')
    expect(result).not.toContain('PVT_old')
    expect(result).toContain('OTHER=world')
  })

  it('does not overwrite existing values without force', () => {
    const existing = 'GITHUB_REPO=Existing/repo\n'
    const sections = [
      {
        header: '# --- dev-core: GitHub Project V2 ---',
        vars: [
          { key: 'GITHUB_REPO', value: 'New/repo' },
          { key: 'PROJECT_ID', value: 'PVT_new' },
        ],
      },
    ]
    const result = mergeEnv(existing, sections, false)
    // Should keep existing value
    expect(result).toContain('GITHUB_REPO=Existing/repo')
    expect(result).toContain('PROJECT_ID=PVT_new')
  })

  it('overwrites existing values with force', () => {
    const existing = '# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=Old/repo\n'
    const result = mergeEnv(existing, baseSections, true)
    expect(result).toContain('GITHUB_REPO=Org/repo')
    expect(result).not.toContain('Old/repo')
  })
})

describe('scaffold', () => {
  let mockFs: Record<string, string | null>
  let writtenFiles: Record<string, string>

  beforeEach(() => {
    mockFs = {}
    writtenFiles = {}
    const fs = require('fs')

    vi.spyOn(fs, 'existsSync').mockImplementation((path: string) => {
      return path in mockFs && mockFs[path] !== null
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation((path: string) => {
      if (path in mockFs && mockFs[path] !== null) return mockFs[path]
      throw new Error('ENOENT')
    })
    vi.spyOn(fs, 'writeFileSync').mockImplementation((path: string, content: string) => {
      writtenFiles[path] = content
    })
    vi.spyOn(fs, 'appendFileSync').mockImplementation((path: string, content: string) => {
      writtenFiles[path] = (writtenFiles[path] ?? '') + content
    })
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
  })

  it('writes .env and .env.example', async () => {
    const { scaffold } = await import('../lib/scaffold')
    const result = await scaffold({
      githubRepo: 'Org/repo',
      projectId: 'PVT_123',
      statusFieldId: 'F1',
      sizeFieldId: 'F2',
      priorityFieldId: 'F3',
      statusOptionsJson: '{}',
      sizeOptionsJson: '{}',
      priorityOptionsJson: '{}',
      dashboardPath: '/path/to/dashboard.ts',
      force: false,
    })

    expect(result.envWritten).toBe(true)
    expect(result.envExampleWritten).toBe(true)
    expect(writtenFiles['.env']).toContain('GITHUB_REPO=Org/repo')
    expect(writtenFiles['.env.example']).toContain('GITHUB_REPO=owner/repo')
  })

  it('updates package.json with dashboard script', async () => {
    mockFs['package.json'] = '{"scripts": {}}'

    const { scaffold } = await import('../lib/scaffold')
    const result = await scaffold({
      githubRepo: 'Org/repo',
      projectId: 'PVT_123',
      statusFieldId: 'F1',
      sizeFieldId: 'F2',
      priorityFieldId: 'F3',
      statusOptionsJson: '{}',
      sizeOptionsJson: '{}',
      priorityOptionsJson: '{}',
      dashboardPath: '/path/to/dashboard.ts',
      force: false,
    })

    expect(result.packageJsonUpdated).toBe(true)
    const pkg = JSON.parse(writtenFiles['package.json'])
    expect(pkg.scripts.dashboard).toBe('bun /path/to/dashboard.ts')
  })

  it('adds .env to .gitignore if missing', async () => {
    mockFs['.gitignore'] = 'node_modules/\n'

    const { scaffold } = await import('../lib/scaffold')
    const result = await scaffold({
      githubRepo: 'Org/repo',
      projectId: 'PVT_123',
      statusFieldId: 'F1',
      sizeFieldId: 'F2',
      priorityFieldId: 'F3',
      statusOptionsJson: '{}',
      sizeOptionsJson: '{}',
      priorityOptionsJson: '{}',
      dashboardPath: '/path/to/dashboard.ts',
      force: false,
    })

    expect(result.gitignoreUpdated).toBe(true)
  })
})
