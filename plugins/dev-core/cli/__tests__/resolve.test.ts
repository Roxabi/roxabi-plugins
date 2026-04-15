/**
 * Tests for cwd → project resolution.
 *
 * Covers:
 *   - parseGitRemoteUrl (SSH / HTTPS / .git suffix / invalid)
 *   - resolveRepoFromCwd (.roxabi marker walk-up, git remote fallback)
 *   - resolveCurrentProject (localPath → git-remote fallback, case-insensitive)
 *   - detectLocalPath (cwd match, ~/projects/<name> scan)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'roxabi-resolve-test-'))
}

function initGitRepo(dir: string, remoteUrl: string): void {
  const run = (args: string[]) => {
    const proc = Bun.spawnSync(args, { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.slice(1).join(' ')} failed: ${new TextDecoder().decode(proc.stderr)}`)
    }
  }
  run(['git', 'init', '-q', '-b', 'main'])
  run(['git', 'remote', 'add', 'origin', remoteUrl])
}

// ---------------------------------------------------------------------------
// parseGitRemoteUrl
// ---------------------------------------------------------------------------

describe('parseGitRemoteUrl', () => {
  it('parses SSH shorthand (git@host:owner/name.git)', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('git@github.com:Roxabi/roxabi-forge.git')).toBe('Roxabi/roxabi-forge')
  })

  it('parses HTTPS URLs with .git suffix', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('https://github.com/Roxabi/roxabi-forge.git')).toBe('Roxabi/roxabi-forge')
  })

  it('parses HTTPS URLs without .git suffix', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('https://github.com/Roxabi/roxabi-forge')).toBe('Roxabi/roxabi-forge')
  })

  it('parses ssh:// protocol URLs', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('ssh://git@github.com/Roxabi/roxabi-forge.git')).toBe('Roxabi/roxabi-forge')
  })

  it('trims surrounding whitespace', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('  git@github.com:owner/repo.git\n')).toBe('owner/repo')
  })

  it('returns null for unrecognized URLs', async () => {
    const { parseGitRemoteUrl } = await import('../lib/workspace')
    expect(parseGitRemoteUrl('not-a-url')).toBeNull()
    expect(parseGitRemoteUrl('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveRepoFromCwd
// ---------------------------------------------------------------------------

describe('resolveRepoFromCwd', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the repo slug from git remote origin', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/roxabi-forge.git')
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(tmpDir)).toBe('Roxabi/roxabi-forge')
  })

  it('returns the repo slug from a subdirectory of the repo', async () => {
    initGitRepo(tmpDir, 'https://github.com/Roxabi/roxabi-forge.git')
    const sub = join(tmpDir, 'plugins', 'forge')
    mkdirSync(sub, { recursive: true })
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(sub)).toBe('Roxabi/roxabi-forge')
  })

  it('prefers .roxabi marker over git remote (monorepo override)', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/monorepo.git')
    writeFileSync(join(tmpDir, '.roxabi'), JSON.stringify({ repo: 'Roxabi/sub-project' }))
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(tmpDir)).toBe('Roxabi/sub-project')
  })

  it('finds .roxabi marker by walking up from a subdirectory', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/monorepo.git')
    writeFileSync(join(tmpDir, '.roxabi'), JSON.stringify({ repo: 'Roxabi/pinned' }))
    const deep = join(tmpDir, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(deep)).toBe('Roxabi/pinned')
  })

  it('falls through to git remote when .roxabi is malformed', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/fallback.git')
    writeFileSync(join(tmpDir, '.roxabi'), 'not valid json{')
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(tmpDir)).toBe('Roxabi/fallback')
  })

  it('returns null for a non-git directory with no marker', async () => {
    const { resolveRepoFromCwd } = await import('../lib/workspace')
    expect(resolveRepoFromCwd(tmpDir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveCurrentProject
// ---------------------------------------------------------------------------

describe('resolveCurrentProject', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('matches by exact localPath', async () => {
    const { resolveCurrentProject } = await import('../commands/issues')
    const projects = [
      { repo: 'Roxabi/a', projectId: 'PVT_a', label: 'A', localPath: '/path/a' },
      { repo: 'Roxabi/b', projectId: 'PVT_b', label: 'B', localPath: '/path/b' },
    ]
    expect(resolveCurrentProject(projects, '/path/b')?.repo).toBe('Roxabi/b')
  })

  it('matches by localPath prefix (subdirectory)', async () => {
    const { resolveCurrentProject } = await import('../commands/issues')
    const projects = [
      { repo: 'Roxabi/a', projectId: 'PVT_a', label: 'A', localPath: '/path/a' },
    ]
    expect(resolveCurrentProject(projects, '/path/a/src/nested')?.repo).toBe('Roxabi/a')
  })

  it('falls back to git-remote when no localPath matches', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/roxabi-forge.git')
    const { resolveCurrentProject } = await import('../commands/issues')
    const projects = [
      { repo: 'Roxabi/roxabi-forge', projectId: 'PVT_f', label: 'Forge' }, // no localPath
      { repo: 'Roxabi/other', projectId: 'PVT_o', label: 'Other' },
    ]
    expect(resolveCurrentProject(projects, tmpDir)?.repo).toBe('Roxabi/roxabi-forge')
  })

  it('matches case-insensitively on the repo slug', async () => {
    initGitRepo(tmpDir, 'git@github.com:ROXABI/Roxabi-Forge.git')
    const { resolveCurrentProject } = await import('../commands/issues')
    const projects = [
      { repo: 'Roxabi/roxabi-forge', projectId: 'PVT_f', label: 'Forge' },
    ]
    expect(resolveCurrentProject(projects, tmpDir)?.repo).toBe('Roxabi/roxabi-forge')
  })

  it('returns null when nothing matches', async () => {
    initGitRepo(tmpDir, 'git@github.com:Someone/unrelated.git')
    const { resolveCurrentProject } = await import('../commands/issues')
    const projects = [
      { repo: 'Roxabi/a', projectId: 'PVT_a', label: 'A', localPath: '/somewhere/else' },
    ]
    expect(resolveCurrentProject(projects, tmpDir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// detectLocalPath
// ---------------------------------------------------------------------------

describe('detectLocalPath', () => {
  let tmpDir: string
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.HOME = originalHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns cwd when cwd is the repo itself', async () => {
    initGitRepo(tmpDir, 'git@github.com:Roxabi/roxabi-forge.git')
    process.chdir(tmpDir)
    const { detectLocalPath } = await import('../lib/workspace')
    expect(detectLocalPath('Roxabi/roxabi-forge')).toBe(tmpDir)
  })

  it('falls back to ~/projects/<name> when cwd does not match', async () => {
    const projectsDir = join(tmpDir, 'projects', 'some-repo')
    mkdirSync(join(projectsDir, '.git'), { recursive: true })
    process.env.HOME = tmpDir
    process.chdir(tmpDir)
    const { detectLocalPath } = await import('../lib/workspace')
    expect(detectLocalPath('Roxabi/some-repo')).toBe(projectsDir)
  })

  it('returns undefined when no candidate directory exists', async () => {
    process.env.HOME = tmpDir
    process.chdir(tmpDir)
    const { detectLocalPath } = await import('../lib/workspace')
    expect(detectLocalPath('Roxabi/does-not-exist')).toBeUndefined()
  })
})
