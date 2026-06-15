/**
 * Tests for cli/lib/workspace-store.ts and cli/commands/workspace.ts.
 *
 * After the ProjectV2 board purge (#268), the workspace is a plain repo→local-path
 * registry. `workspace add` registers a repo directly — no board discovery, no fetch.
 *
 * - workspace list — table with repo + label columns
 * - workspace add — writes {repo, label} entry, exits 0 with confirmation
 * - workspace remove (registered repo) — removes entry, exits 0 with message
 * - workspace remove (unregistered repo) — exits 1 with error
 * - path resolution — ~/.roxabi-vault/workspace.json when vault exists, else
 *     ~/.config/roxabi/workspace.json with 0700 parent dir on fresh install
 * - parseWorkspace — fail-loud validation at the workspace.json boundary
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'roxabi-workspace-test-'))
}

/**
 * Build a minimal workspace.json fixture with the given projects.
 */
function makeWorkspaceJson(projects: Array<{ repo: string; label: string; localPath?: string }>) {
  return `${JSON.stringify({ projects }, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// workspace list
// ---------------------------------------------------------------------------

describe('workspace list', () => {
  it('prints table with repo and label columns', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(
      workspacePath,
      makeWorkspaceJson([
        { repo: 'Roxabi/roxabi-plugins', label: 'Roxabi Plugins' },
        { repo: 'octocat/repo-b', label: 'Personal Repo B' },
      ]),
    )
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      const { run } = await import('../commands/workspace')
      await run(['list'])

      console.log = originalLog

      const output = lines.join('\n')
      expect(output).toContain('repo')
      expect(output).toContain('label')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(output).toContain('Roxabi Plugins')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('prints empty-state message when workspace has no projects', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    require('node:fs').writeFileSync(join(vaultDir, 'workspace.json'), makeWorkspaceJson([]))
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      const { run } = await import('../commands/workspace')
      await run(['list'])

      console.log = originalLog

      const output = lines.join('\n')
      expect(output.length).toBeGreaterThan(0)
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// workspace add
// ---------------------------------------------------------------------------

describe('workspace add', () => {
  it('writes the repo entry to workspace.json and exits 0 with confirmation message', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => {
        exitCode = code ?? 0
      }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/roxabi-plugins'])

      console.log = originalLog
      process.exit = originalExit

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('Roxabi/roxabi-plugins')
      expect(written.projects[0].label).toBe('Roxabi/roxabi-plugins')

      const output = lines.join('\n')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(exitCode).toBeUndefined()
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('overwrites the existing entry when the repo is already registered', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(
      workspacePath,
      makeWorkspaceJson([{ repo: 'Roxabi/roxabi-plugins', label: 'Roxabi/roxabi-plugins' }]),
    )

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const originalLog = console.log
      console.log = () => {}

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/roxabi-plugins', '--local', '/home/me/plugins'])

      console.log = originalLog

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].localPath).toBe('/home/me/plugins')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// workspace remove — registered repo
// ---------------------------------------------------------------------------

describe('workspace remove (registered repo)', () => {
  it('removes the entry from workspace.json and exits 0 with a confirmation message', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(
      workspacePath,
      makeWorkspaceJson([
        { repo: 'Roxabi/roxabi-plugins', label: 'Plugins' },
        { repo: 'octocat/repo-b', label: 'Repo B' },
      ]),
    )
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => {
        exitCode = code ?? 0
      }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['remove', 'Roxabi/roxabi-plugins'])

      console.log = originalLog
      process.exit = originalExit

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('octocat/repo-b')

      const output = lines.join('\n')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(exitCode === undefined || exitCode === 0).toBe(true)
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// workspace remove — unregistered repo
// ---------------------------------------------------------------------------

describe('workspace remove (unregistered repo)', () => {
  it('exits 1 with an actionable error message when the repo is not registered', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([{ repo: 'octocat/repo-b', label: 'Repo B' }]))
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const errorLines: string[] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => errorLines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => {
        exitCode = code
      }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['remove', 'unknown/repo'])

      console.error = originalError
      process.exit = originalExit

      expect(exitCode).toBe(1)

      const output = errorLines.join('\n')
      expect(output.length).toBeGreaterThan(0)
      expect(output).toContain('unknown/repo')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  it('uses ~/.roxabi-vault/workspace.json when vault dir exists', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const { getWorkspacePath } = await import('../lib/workspace-store')
      const resolved = getWorkspacePath()

      expect(resolved).toBe(join(tmpDir, '.roxabi-vault', 'workspace.json'))
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses ~/.config/roxabi/workspace.json when vault dir does not exist', async () => {
    const tmpDir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const { getWorkspacePath } = await import('../lib/workspace-store')
      const resolved = getWorkspacePath()

      expect(resolved).toBe(join(tmpDir, '.config', 'roxabi', 'workspace.json'))
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('creates ~/.config/roxabi/ with mode 0700 on fresh install (no vault, no config dir)', async () => {
    const tmpDir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const { writeWorkspace } = await import('../lib/workspace-store')
      writeWorkspace({ projects: [{ repo: 'test/repo', label: 'Fresh Project' }] })

      const configDir = join(tmpDir, '.config', 'roxabi')
      expect(existsSync(configDir)).toBe(true)

      const stats = statSync(configDir)
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o700)

      const workspacePath = join(configDir, 'workspace.json')
      expect(existsSync(workspacePath)).toBe(true)
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// parseWorkspace — fail-loud validation at the workspace.json boundary
// ---------------------------------------------------------------------------

describe('parseWorkspace', () => {
  it('accepts a valid workspace with multiple projects', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    const result = parseWorkspace({
      projects: [
        { repo: 'Roxabi/a', label: 'A' },
        { repo: 'Roxabi/b', label: 'B', localPath: '/path/b' },
      ],
    })
    expect(result.projects).toHaveLength(2)
    expect(result.projects[0].repo).toBe('Roxabi/a')
    expect(result.projects[1].localPath).toBe('/path/b')
  })

  it('accepts an empty projects array', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(parseWorkspace({ projects: [] })).toEqual({ projects: [] })
  })

  it('throws with field path when projects is missing', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() => parseWorkspace({})).toThrow(/projects/)
  })

  it('throws when projects is not an array', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() => parseWorkspace({ projects: 'not an array' })).toThrow(/array/)
  })

  it('throws with index when a required field is missing', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() =>
      parseWorkspace({
        projects: [
          { repo: 'Roxabi/a', label: 'A' },
          { repo: 'Roxabi/b' }, // missing label
        ],
      }),
    ).toThrow(/projects\[1\]\.label/)
  })

  it('throws when a required field is an empty string', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() =>
      parseWorkspace({
        projects: [{ repo: 'Roxabi/a', label: '' }],
      }),
    ).toThrow(/projects\[0\]\.label.*non-empty/)
  })

  it('throws when localPath is present but not a string', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() =>
      parseWorkspace({
        projects: [{ repo: 'Roxabi/a', label: 'A', localPath: 42 }],
      }),
    ).toThrow(/localPath/)
  })

  it('throws on null input', async () => {
    const { parseWorkspace } = await import('../lib/workspace-store')
    expect(() => parseWorkspace(null)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// workspace add --local flag
// ---------------------------------------------------------------------------

describe('workspace add --local', () => {
  it('persists --local path to workspace.json', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/test-repo', '--local', '/custom/path/to/repo'])

      console.log = originalLog

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].localPath).toBe('/custom/path/to/repo')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects --local path with ".." traversal', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const errorLines: string[] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => errorLines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => {
        exitCode = code
      }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/test-repo', '--local', '/path/../etc'])

      console.error = originalError
      process.exit = originalExit

      expect(exitCode).toBe(1)
      expect(errorLines.join('\n')).toContain('Invalid --local path')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('accepts relative path with "./"', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/test-repo', '--local', './local-repo'])

      console.log = originalLog

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects[0].localPath).toBe('./local-repo')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
