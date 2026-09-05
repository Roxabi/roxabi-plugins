import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Shared test suite for `detectGitHubRepo` repo detection.
 *
 * **Caller contract — required hoisted mock.** Each calling test file must
 * hoist a `node:fs` mock at module scope (vitest hoists `vi.mock(...)` above
 * imports) to block `.claude/dev-core.yml` reads so config-helper loads stay
 * deterministic. The suite installs its own `Bun.spawnSync` / `execSync` spies.
 */
export function registerGitHubRepoDetectionSuite(opts: { detectGitHubRepo: () => string }) {
  const { detectGitHubRepo } = opts
  // Capture the live pre-test value once so the block restores the caller's
  // real GITHUB_REPO (not a hardcoded sentinel) in its afterEach.
  const originalGitHubRepo = process.env.GITHUB_REPO

  describe('detectGitHubRepo', () => {
    let spawnSyncSpy: ReturnType<typeof vi.spyOn>
    let execSyncSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      delete process.env.GITHUB_REPO
      spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
      // Mock execSync to throw (simulating gh CLI not available)
      // This forces the code to use git detection path
      execSyncSpy = vi.spyOn(require('node:child_process'), 'execSync').mockImplementation(() => {
        throw new Error('gh: command not found')
      })
    })

    afterEach(() => {
      if (originalGitHubRepo !== undefined) {
        process.env.GITHUB_REPO = originalGitHubRepo
      } else {
        delete process.env.GITHUB_REPO
      }
      spawnSyncSpy.mockRestore()
      execSyncSpy.mockRestore()
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

    it('accepts single-char owner and repo-name segments', () => {
      // Each segment is [A-Za-z0-9][...]* — the continuation is optional, so a/b is valid.
      // Pins the `*` quantifier against an accidental change to `+` (which would require ≥2 chars).
      process.env.GITHUB_REPO = 'a/b'
      expect(detectGitHubRepo()).toBe('a/b')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('accepts dots and underscores in the repo-name segment', () => {
      // Repo names may contain . and _ — owner tightening must not regress this.
      process.env.GITHUB_REPO = 'owner/my.repo_name'
      expect(detectGitHubRepo()).toBe('owner/my.repo_name')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when the owner segment starts with a hyphen', () => {
      // Both segments must start with an alphanumeric — leading special chars are rejected.
      process.env.GITHUB_REPO = '-bad/repo'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo "-bad/repo"')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('throws when the repo-name segment starts with a hyphen', () => {
      // Both segments must start with an alphanumeric — leading special chars are rejected.
      process.env.GITHUB_REPO = 'owner/-bad'
      expect(() => detectGitHubRepo()).toThrow('Invalid GitHub repo "owner/-bad"')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('parses SSH remote URL', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh') return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 1, success: false }
        return {
          stdout: new TextEncoder().encode('git@github.com:Roxabi/roxabi-plugins.git\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        }
      })

      expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
    })

    it('parses HTTPS remote URL', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh') return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 1, success: false }
        return {
          stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins.git\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        }
      })

      const result = detectGitHubRepo()
      expect(result).toBe('Roxabi/roxabi-plugins')
    })

    it('parses HTTPS remote URL without .git suffix', () => {
      spawnSyncSpy.mockImplementation((cmd: string[]) => {
        if (cmd[0] === 'gh') return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 1, success: false }
        return {
          stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins\n'),
          stderr: new Uint8Array(),
          exitCode: 0,
          success: true,
        }
      })

      expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
    })

    it('throws when no env var, no git remote, and no gh CLI', () => {
      // beforeEach already deleted GITHUB_REPO; afterEach restores originalGitHubRepo.
      // No in-test save/restore needed — that path forces git detection.

      // Mock git to fail
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
