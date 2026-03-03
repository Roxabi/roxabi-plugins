import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeEnv, mergeEnvExample } from '../lib/scaffold'

describe('mergeEnv', () => {
  const baseSections = [
    {
      header: '# --- dev-core: GitHub Project V2 ---',
      vars: [
        { key: 'GITHUB_REPO', value: 'Org/repo' },
        { key: 'GH_PROJECT_ID', value: 'PVT_123' },
      ],
    },
  ]

  it('writes dev-core section to empty .env', () => {
    const result = mergeEnv('', baseSections, false)
    expect(result).toContain('GITHUB_REPO=Org/repo')
    expect(result).toContain('GH_PROJECT_ID=PVT_123')
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
    const existing =
      'MY_VAR=hello\n# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=Old/repo\nGH_PROJECT_ID=PVT_old\n\nOTHER=world\n'
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
          { key: 'GH_PROJECT_ID', value: 'PVT_new' },
        ],
      },
    ]
    const result = mergeEnv(existing, sections, false)
    // Should keep existing value
    expect(result).toContain('GITHUB_REPO=Existing/repo')
    expect(result).toContain('GH_PROJECT_ID=PVT_new')
  })

  it('overwrites existing values with force', () => {
    const existing = '# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=Old/repo\nGH_PROJECT_ID=PVT_old\n'
    const result = mergeEnv(existing, baseSections, true)
    expect(result).toContain('GITHUB_REPO=Org/repo')
    expect(result).not.toContain('Old/repo')
    expect(result).not.toContain('PVT_old')
    expect(result).toContain('GH_PROJECT_ID=PVT_123')
  })
})

describe('mergeEnvExample', () => {
  const newBlock = '# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=owner/repo\n'

  it('returns new block for empty file', () => {
    const result = mergeEnvExample('', newBlock)
    expect(result).toBe(newBlock)
  })

  it('preserves non-dev-core lines', () => {
    const existing = 'MY_APP_VAR=something\nDB_URL=postgres://...\n'
    const result = mergeEnvExample(existing, newBlock)
    expect(result).toContain('MY_APP_VAR=something')
    expect(result).toContain('DB_URL=postgres://...')
    expect(result).toContain('GITHUB_REPO=owner/repo')
  })

  it('replaces existing dev-core block', () => {
    const existing = 'MY_APP_VAR=foo\n# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=old/repo\n\nOTHER=bar\n'
    const result = mergeEnvExample(existing, newBlock)
    expect(result).toContain('MY_APP_VAR=foo')
    expect(result).toContain('OTHER=bar')
    expect(result).toContain('GITHUB_REPO=owner/repo')
    expect(result).not.toContain('old/repo')
  })

  it('handles file with only dev-core content', () => {
    const existing = '# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=old/repo\n'
    const result = mergeEnvExample(existing, newBlock)
    expect(result).toBe(newBlock)
    expect(result).not.toContain('old/repo')
  })
})

describe('scaffold', () => {
  let mockFs: Record<string, string | null>
  let writtenFiles: Record<string, string>

  beforeEach(() => {
    mockFs = {}
    writtenFiles = {}
    const fs = require('fs')

    vi.spyOn(fs, 'existsSync').mockImplementation((...args: unknown[]) => {
      const path = args[0] as string
      return path in mockFs && mockFs[path] !== null
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: unknown[]) => {
      const path = args[0] as string
      if (path in mockFs && mockFs[path] !== null) return mockFs[path]
      throw new Error('ENOENT')
    })
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
      const [path, content] = args as [string, string]
      writtenFiles[path] = content
    })
    vi.spyOn(fs, 'appendFileSync').mockImplementation((...args: unknown[]) => {
      const [path, content] = args as [string, string]
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
      force: false,
    })

    expect(result.envWritten).toBe(true)
    expect(result.envExampleWritten).toBe(true)
    expect(writtenFiles['.env']).toContain('GITHUB_REPO=Org/repo')
    expect(writtenFiles['.env.example']).toContain('GITHUB_REPO=owner/repo')
  })

  it('preserves existing .env.example user content on re-init', async () => {
    mockFs['.env.example'] = 'MY_APP_VAR=something\n# --- dev-core: GitHub Project V2 ---\nGITHUB_REPO=old/repo\n'

    const { scaffold } = await import('../lib/scaffold')
    await scaffold({
      githubRepo: 'Org/repo',
      projectId: 'PVT_123',
      statusFieldId: 'F1',
      sizeFieldId: 'F2',
      priorityFieldId: 'F3',
      statusOptionsJson: '{}',
      sizeOptionsJson: '{}',
      priorityOptionsJson: '{}',
      force: false,
    })

    expect(writtenFiles['.env.example']).toContain('MY_APP_VAR=something')
    expect(writtenFiles['.env.example']).toContain('GITHUB_REPO=owner/repo')
    expect(writtenFiles['.env.example']).not.toContain('old/repo')
  })

  it('writes roxabi shim to ~/.local/bin/roxabi', async () => {
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
      force: false,
    })

    expect(result.shimWritten).toBe(true)
    expect(result.shimPath).toContain('roxabi')
    const shimContent = writtenFiles[result.shimPath]
    expect(shimContent).toContain('dev-core')
    expect(shimContent).toContain('.orphaned_at')
    expect(shimContent).toContain('cli/index.ts')
    // PATH update: appended to rc files
    expect(result.pathUpdated).toBe(true)
    expect(result.pathFiles.length).toBeGreaterThan(0)
    const rcContent = writtenFiles[result.pathFiles[0]]
    expect(rcContent).toContain('PATH')
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
      force: false,
    })

    expect(result.gitignoreUpdated).toBe(true)
  })
})
