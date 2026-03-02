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
      // Act: import workspace command and capture stdout
      // (import is dynamic so the module reads the patched HOME)
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      // This import will fail (RED) until cli/commands/workspace.ts exists
      const { run } = await import('../commands/workspace')
      await run(['list'])

      console.log = originalLog

      // Assert: all three column headers appear in output
      const output = lines.join('\n')
      expect(output).toContain('repo')
      expect(output).toContain('projectId')
      expect(output).toContain('label')
      // Assert: project data appears in output
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(output).toContain('PVT_kwDORa9q-M4Aqkwn')
      expect(output).toContain('Roxabi Plugins')
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('prints empty-state message when workspace has no projects', async () => {
    // Arrange: vault dir with empty workspace.json
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
      // Act
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(' '))

      const { run } = await import('../commands/workspace')
      await run(['list'])

      console.log = originalLog

      // Assert: some form of "no projects" indication
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
    // Arrange: vault dir exists (empty workspace), GraphQL mock returns 1 project
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const workspacePath = join(vaultDir, 'workspace.json')
    require('node:fs').writeFileSync(workspacePath, makeWorkspaceJson([]))

    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    // Mock fetch to return a single GitHub project
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
      // Act
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

      // Assert: workspace.json updated with new entry
      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('Roxabi/roxabi-plugins')
      expect(written.projects[0].projectId).toBe('PVT_kwDORa9q-M4Aqkwn')
      expect(written.projects[0].label).toBe('Roxabi Plugins')

      // Assert: confirmation message printed, clean exit
      const output = lines.join('\n')
      expect(output).toContain('Roxabi/roxabi-plugins')
      expect(exitCode).toBeUndefined() // no explicit exit on success, or exit(0)
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
  // Deferred to S5 — requires stdin mock for interactive prompt.
  // SC-4: implement when commands/workspace.ts supports mockable stdin.

  it.todo('writes the user-selected entry after prompt')
  // Deferred to S5 — requires stdin mock for interactive prompt.
})

// ---------------------------------------------------------------------------
// workspace remove — registered repo (SC-6)
// ---------------------------------------------------------------------------

describe('workspace remove (registered repo)', () => {
  it('removes the entry from workspace.json and exits 0 with a confirmation message', async () => {
    // Arrange: workspace.json with two projects
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
      // Act
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

      // Assert: entry removed from workspace.json
      const written = JSON.parse(readFileSync(workspacePath, 'utf8'))
      expect(written.projects).toHaveLength(1)
      expect(written.projects[0].repo).toBe('mickaelV0/repo-b')

      // Assert: confirmation message, exit 0
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
    // Arrange: workspace.json with no matching entry
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
      // Act
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

      // Assert: exit 1
      expect(exitCode).toBe(1)

      // Assert: error message mentions the repo
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
    // Arrange: vault dir present
    const tmpDir = makeTmpDir()
    const vaultDir = join(tmpDir, '.roxabi-vault')
    mkdirSync(vaultDir, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      // Act: import workspace lib and call getWorkspacePath()
      // This import will fail (RED) until cli/lib/workspace.ts exists
      const { getWorkspacePath } = await import('../lib/workspace')
      const resolved = getWorkspacePath()

      // Assert: path points into the vault dir
      expect(resolved).toBe(join(tmpDir, '.roxabi-vault', 'workspace.json'))
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses ~/.config/roxabi/workspace.json when vault dir does not exist', async () => {
    // Arrange: no vault dir, no config dir
    const tmpDir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    try {
      // Act
      const { getWorkspacePath } = await import('../lib/workspace')
      const resolved = getWorkspacePath()

      // Assert: falls back to XDG-style config path
      expect(resolved).toBe(join(tmpDir, '.config', 'roxabi', 'workspace.json'))
    } finally {
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('creates ~/.config/roxabi/ with mode 0700 on fresh install (no vault, no config dir)', async () => {
    // Arrange: completely fresh HOME — neither vault nor config dir exist
    const tmpDir = makeTmpDir()
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir

    // Mock fetch so discoverProject doesn't hit the network
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
      // Act: writeWorkspace() must create the parent dir with 0700
      const { writeWorkspace } = await import('../lib/workspace')
      writeWorkspace({ projects: [{ repo: 'test/repo', projectId: 'PVT_fresh', label: 'Fresh Project' }] })

      // Assert: config dir created
      const configDir = join(tmpDir, '.config', 'roxabi')
      expect(existsSync(configDir)).toBe(true)

      // Assert: directory mode is 0700 (rwx------)
      const stats = statSync(configDir)
      // Node fs returns octal mode; mask to permission bits only
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o700)

      // Assert: workspace.json written
      const workspacePath = join(configDir, 'workspace.json')
      expect(existsSync(workspacePath)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      process.env.HOME = originalHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
