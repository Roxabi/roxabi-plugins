import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ConfigHelpersModule {
  GH_PROJECT_ID: string
  detectGitHubRepo: () => string
}

export function registerGitHubRepoDetectionSuite(opts: {
  detectGitHubRepo: () => string
  loadConfigHelpers: () => Promise<ConfigHelpersModule>
}) {
  const { detectGitHubRepo, loadConfigHelpers } = opts

  describe('gh_project_id auto-detect', () => {
    let spawnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // GH_PROJECT_ID must not be set — forces the gh CLI auto-detect path
      delete process.env.GH_PROJECT_ID
      // GITHUB_REPO must be valid so detectGitHubRepo() resolves without spawning
      process.env.GITHUB_REPO = 'Test/test-repo'
    })

    afterEach(() => {
      spawnSpy?.mockRestore()
      delete process.env.GH_PROJECT_ID
      process.env.GITHUB_REPO = 'Test/test-repo'
      vi.resetModules()
    })

    it('uses typed -f variables for owner and name (no interpolation in query)', async () => {
      let capturedCmd: string[] = []

      spawnSpy = vi.spyOn(Bun, 'spawnSync').mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh' && cmd[1] === 'repo') {
          return {
            stdout: new TextEncoder().encode('Owner/repo\n'),
            stderr: new Uint8Array(),
            exitCode: 0,
            success: true,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
        if (cmd[0] === 'gh' && cmd[1] === 'api') {
          capturedCmd = [...cmd]
          return {
            stdout: new TextEncoder().encode('PVT_test123\n'),
            stderr: new Uint8Array(),
            exitCode: 0,
            success: true,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
        return {
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          exitCode: 1,
          success: false,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      vi.resetModules()
      const mod = await loadConfigHelpers()

      expect(mod.GH_PROJECT_ID).toBe('PVT_test123')

      // owner and name passed as typed -f variables — not interpolated into query string
      const ownerFlagIdx = capturedCmd.indexOf('owner=Owner')
      const nameFlagIdx = capturedCmd.indexOf('name=repo')
      expect(ownerFlagIdx).toBeGreaterThan(-1)
      expect(nameFlagIdx).toBeGreaterThan(-1)
      // each typed variable must be preceded by '-f'
      expect(capturedCmd[ownerFlagIdx - 1]).toBe('-f')
      expect(capturedCmd[nameFlagIdx - 1]).toBe('-f')

      // query= arg must use $owner / $name placeholders — NOT the literal owner value
      const queryArg = capturedCmd.find((a) => a.startsWith('query=')) ?? ''
      expect(queryArg).toContain('$owner')
      expect(queryArg).toContain('$name')
      expect(queryArg).not.toContain('"Owner"')
      expect(queryArg).not.toContain('"repo"')
    })

    it('does not call gh api graphql when gh repo view returns a hostile slug', async () => {
      let graphqlSpawned = false

      spawnSpy = vi.spyOn(Bun, 'spawnSync').mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh' && cmd[1] === 'repo') {
          return {
            // Hostile slug — assertValidRepoSlug must reject this before graphql is called
            stdout: new TextEncoder().encode('a") { x } #/b\n'),
            stderr: new Uint8Array(),
            exitCode: 0,
            success: true,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
        if (cmd[0] === 'gh' && cmd[1] === 'api') {
          graphqlSpawned = true
          return {
            stdout: new TextEncoder().encode('PVT_should_not_reach\n'),
            stderr: new Uint8Array(),
            exitCode: 0,
            success: true,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
        return {
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          exitCode: 1,
          success: false,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      vi.resetModules()
      const mod = await loadConfigHelpers()

      // assertValidRepoSlug throws → catch swallows → GH_PROJECT_ID falls back to ''
      expect(mod.GH_PROJECT_ID).toBe('')
      // graphql spawn must never have fired
      expect(graphqlSpawned).toBe(false)
    })
  })

  describe('detectGitHubRepo', () => {
    const originalEnv = process.env.GITHUB_REPO
    let spawnSyncSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      delete process.env.GITHUB_REPO
      spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
    })

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.GITHUB_REPO = originalEnv
      } else {
        delete process.env.GITHUB_REPO
      }
      spawnSyncSpy.mockRestore()
    })

    it('prefers GITHUB_REPO env var when set', () => {
      process.env.GITHUB_REPO = 'MyOrg/my-repo'
      expect(detectGitHubRepo()).toBe('MyOrg/my-repo')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when GITHUB_REPO lacks a slash (no owner/repo)', () => {
      process.env.GITHUB_REPO = 'myrepo'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo "myrepo"')
      // Must reject before falling through to git remote detection.
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when GITHUB_REPO has an empty segment', () => {
      process.env.GITHUB_REPO = 'owner/'
      expect(() => detectGitHubRepo()).toThrow('Expected "owner/repo" format')
    })

    it('throws when GITHUB_REPO has extra path segments', () => {
      process.env.GITHUB_REPO = 'owner/repo/extra'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when GITHUB_REPO has a leading slash (empty owner)', () => {
      process.env.GITHUB_REPO = '/repo'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when GITHUB_REPO is whitespace-padded', () => {
      process.env.GITHUB_REPO = ' owner/repo '
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when the owner segment contains a dot', () => {
      // GitHub owners (users/orgs) are [A-Za-z0-9-] only — no dots, unlike repo names.
      process.env.GITHUB_REPO = 'my.org/repo'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo "my.org/repo"')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when the owner segment contains an underscore', () => {
      process.env.GITHUB_REPO = 'my_org/repo'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo "my_org/repo"')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('accepts a numeric-only owner/repo slug', () => {
      // Digits are valid in both segments — 123/456 must pass.
      process.env.GITHUB_REPO = '123/456'
      expect(detectGitHubRepo()).toBe('123/456')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('accepts dots and underscores in the repo-name segment', () => {
      // Repo names may contain . and _ — owner tightening must not regress this.
      process.env.GITHUB_REPO = 'owner/my.repo_name'
      expect(detectGitHubRepo()).toBe('owner/my.repo_name')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('parses SSH remote URL', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh')
          return {
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            exitCode: 1,
            success: false,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        return {
          stdout: new TextEncoder().encode('git@github.com:Roxabi/roxabi-plugins.git\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
    })

    it('parses HTTPS remote URL', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh')
          return {
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            exitCode: 1,
            success: false,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        return {
          stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins.git\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      const result = detectGitHubRepo()
      expect(result).toBe('Roxabi/roxabi-plugins')
    })

    it('parses HTTPS remote URL without .git suffix', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh')
          return {
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            exitCode: 1,
            success: false,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        return {
          stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
    })

    it('returns owner/repo from gh CLI when gh succeeds (no env var, no git remote needed)', () => {
      // Arrange: gh CLI returns a valid nameWithOwner slug
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh') {
          return {
            stdout: new TextEncoder().encode('Roxabi/roxabi-plugins\n'),
            stderr: new Uint8Array(),
            exitCode: 0,
            success: true,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
        // git remote should not be reached
        return {
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode('should not be called\n'),
          exitCode: 128,
          success: false,
        } as unknown as ReturnType<typeof Bun.spawnSync>
      })

      // Act
      const result = detectGitHubRepo()

      // Assert: slug comes from gh CLI, git remote was not the source
      expect(result).toBe('Roxabi/roxabi-plugins')
      const gitCalls = spawnSyncSpy.mock.calls.filter((args: unknown[]) => (args[0] as string[])?.[0] === 'git')
      expect(gitCalls).toHaveLength(0)
    })

    it('throws when no env var, no git remote, and no gh CLI', () => {
      // Mock all Bun.spawnSync calls to fail (gh + git remote both unavailable)
      spawnSyncSpy.mockReturnValue({
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode('fatal: not a git repository\n'),
        exitCode: 128,
        success: false,
      } as unknown as ReturnType<typeof Bun.spawnSync>)

      // The function should throw when detection fails
      expect(() => detectGitHubRepo()).toThrow('Cannot detect GitHub repo')
    })
  })
}
