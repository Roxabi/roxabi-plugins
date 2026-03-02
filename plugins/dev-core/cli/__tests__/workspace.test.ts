/**
 * RED tests for cli/lib/workspace.ts and cli/commands/workspace.ts
 *
 * These tests are expected to FAIL until the implementation exists (S2 RED phase).
 * Covers spec criteria SC-3 through SC-9.
 *
 * SC-3: workspace list — table with repo, projectId, label columns
 * SC-4: workspace add (single project) — writes entry, exits 0 with confirmation
 * SC-5: workspace add (multiple projects) — prompts numbered list
 * SC-6: workspace remove (registered repo) — removes entry, exits 0 with message
 * SC-7: workspace remove (unregistered repo) — exits 1 with error
 * SC-8: path resolution — uses ~/.roxabi-vault/workspace.json when vault exists
 * SC-9: path resolution (fresh install) — creates ~/.config/roxabi/workspace.json
 *        with 0700 parent dir when neither vault nor config dir exist
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
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
function makeWorkspaceJson(projects: Array<{ repo: string; projectId: string; label: string }>) {
  return JSON.stringify({ projects }, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// workspace list (SC-3)
// ---------------------------------------------------------------------------

describe('workspace list', () => {
  it('prints table with repo, projectId, and label columns', async () => {
    // Arrange: workspace.json with two projects
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(
      workspacePath,
      makeWorkspaceJson([
        { repo: 'Roxabi/roxabi-plugins', projectId: 'PVT_kwDORa9q-M4Aqkwn', label: 'Roxabi Plugins' },
        { repo: 'mickaelV0/repo-b', projectId: 'PVT_aabbcc', label: 'Personal Repo B' },
      ])
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
      expect(output).toContain('projectId')
      expect(output).toContain('label')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(output).toContain('PVT_kwDORa9q-M4Aqkwn')
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
    require('node:fs').writeFileSync(
      join(vaultDir, 'workspace.json'),
      makeWorkspaceJson([])
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
      expect(output.length).toBeGreaterThan(0)
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// workspace add — single project found (SC-4)
// ---------------------------------------------------------------------------

describe('workspace add (single project found)', () => {
  it('writes the discovered entry to workspace.json and exits 0 with confirmation message', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              repository: {
                projectsV2: {
                  nodes: [
                    { id: 'PVT_kwDORa9q-M4Aqkwn', title: 'Roxabi Plugins' },
                  ],
                },
              },
            },
          }),
      })
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => { exitCode = code ?? 0 }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['add', 'Roxabi/roxabi-plugins'])

      console.log = originalLog
      process.exit = originalExit

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('Roxabi/roxabi-plugins')
      expect(written.projects[0].projectId).toBe('PVT_kwDORa9q-M4Aqkwn')
      expect(written.projects[0].label).toBe('Roxabi Plugins')

      const output = lines.join('\n')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(exitCode).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// workspace add — multiple projects found (SC-5)
// ---------------------------------------------------------------------------

describe('workspace add (multiple projects found)', () => {
  it.todo('prompts a numbered list when multiple GitHub Projects are linked to the repo')
  it.todo('writes the user-selected entry after prompt')
})

// ---------------------------------------------------------------------------
// workspace remove — registered repo (SC-6)
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
        { repo: 'Roxabi/roxabi-plugins', projectId: 'PVT_aaa', label: 'Plugins' },
        { repo: 'mickaelV0/repo-b', projectId: 'PVT_bbb', label: 'Repo B' },
      ])
    )
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => { exitCode = code ?? 0 }) as typeof process.exit

      const { run } = await import('../commands/workspace')
      await run(['remove', 'Roxabi/roxabi-plugins'])

      console.log = originalLog
      process.exit = originalExit

      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('mickaelV0/repo-b')

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
// workspace remove — unregistered repo (SC-7)
// ---------------------------------------------------------------------------

describe('workspace remove (unregistered repo)', () => {
  it('exits 1 with an actionable error message when the repo is not registered', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(
      workspacePath,
      makeWorkspaceJson([
        { repo: 'mickaelV0/repo-b', projectId: 'PVT_bbb', label: 'Repo B' },
      ])
    )
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const errorLines: string[] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => errorLines.push(args.join(' '))

      let exitCode: number | undefined
      const originalExit = process.exit
      process.exit = ((code?: number) => { exitCode = code }) as typeof process.exit

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
// Path resolution (SC-8, SC-9)
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  it('uses ~/.roxabi-vault/workspace.json when vault dir exists', async () => {
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      const { getWorkspacePath } = await import('../lib/workspace')
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
      const { getWorkspacePath } = await import('../lib/workspace')
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

    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              repository: {
                projectsV2: {
                  nodes: [{ id: 'PVT_fresh', title: 'Fresh Project' }],
                },
              },
            },
          }),
      })
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const { writeWorkspace } = await import('../lib/workspace')
      writeWorkspace({ projects: [{ repo: 'test/repo', projectId: 'PVT_fresh', label: 'Fresh Project' }] })

      const configDir = join(tmpDir, '.config', 'roxabi')
      expect(existsSync(configDir)).toBe(true)

      const stats = statSync(configDir)
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o700)

      const workspacePath = join(configDir, 'workspace.json')
      expect(existsSync(workspacePath)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
