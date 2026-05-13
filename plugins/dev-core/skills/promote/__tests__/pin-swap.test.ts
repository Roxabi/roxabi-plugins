import { describe, expect, it, vi } from 'vitest'
import {
  applyPinSwap,
  buildPinSwapPlan,
  type Deps,
  formatPlan,
  type PinSwapPlan,
  parseUvGitDeps,
  readLockedSha,
  resolveTagAtSha,
  rewritePyproject,
} from '../lib/pin-swap'

// ─── parseUvGitDeps ───────────────────────────────────────────────────────────

describe('parseUvGitDeps', () => {
  it('returns empty array when no [tool.uv.sources] section', () => {
    const toml = '[tool.poetry]\nname = "myapp"\n'
    expect(parseUvGitDeps(toml)).toEqual([])
  })

  it('returns empty array when sources section has no git entries', () => {
    const toml = '[tool.uv.sources]\nlibA = { url = "https://example.com/lib.tar.gz" }\n'
    expect(parseUvGitDeps(toml)).toEqual([])
  })

  it('returns empty array when git source has no branch= (tag= instead)', () => {
    const toml = '[tool.uv.sources]\nlibA = { git = "https://github.com/org/libA", tag = "v1.0.0" }\n'
    expect(parseUvGitDeps(toml)).toEqual([])
  })

  it('parses inline table with branch=', () => {
    const toml = [
      '[tool.uv.sources]',
      'roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }',
    ].join('\n')
    const result = parseUvGitDeps(toml)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: 'roxabi-nats',
      source: { git: 'https://github.com/Roxabi/roxabi-nats', branch: 'staging' },
    })
  })

  it('parses multiple inline table entries', () => {
    const toml = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      'libB = { git = "https://github.com/org/libB", branch = "dev" }',
    ].join('\n')
    const result = parseUvGitDeps(toml)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.name)).toEqual(['libA', 'libB'])
  })

  it('skips entries without branch= even when git= is present', () => {
    const toml = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", rev = "abc123" }',
      'libB = { git = "https://github.com/org/libB", branch = "staging" }',
    ].join('\n')
    const result = parseUvGitDeps(toml)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('libB')
  })

  it('parses sub-table form', () => {
    const toml = [
      '[tool.uv.sources.roxabi-nats]',
      'git = "https://github.com/Roxabi/roxabi-nats"',
      'branch = "staging"',
    ].join('\n')
    const result = parseUvGitDeps(toml)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: 'roxabi-nats',
      source: { git: 'https://github.com/Roxabi/roxabi-nats', branch: 'staging' },
    })
  })

  it('stops parsing sources at the next unrelated section header', () => {
    const toml = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      '[tool.ruff]',
      'libB = { git = "https://github.com/org/libB", branch = "staging" }',
    ].join('\n')
    const result = parseUvGitDeps(toml)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('libA')
  })
})

// ─── readLockedSha ────────────────────────────────────────────────────────────

describe('readLockedSha', () => {
  const uvLock = [
    '[[package]]',
    'name = "roxabi-nats"',
    'version = "0.2.0"',
    'source = { git = "https://github.com/Roxabi/roxabi-nats", rev = "abc123def456abc123def456abc123def456abc1" }',
    '',
    '[[package]]',
    'name = "other-lib"',
    'version = "1.0.0"',
    'source = { git = "https://github.com/org/other", rev = "111222333444111222333444111222333444abcd" }',
  ].join('\n')

  it('returns SHA for a known package', () => {
    const sha = readLockedSha(uvLock, 'roxabi-nats')
    expect(sha).toBe('abc123def456abc123def456abc123def456abc1')
  })

  it('returns SHA for another package', () => {
    const sha = readLockedSha(uvLock, 'other-lib')
    expect(sha).toBe('111222333444111222333444111222333444abcd')
  })

  it('returns null for unknown package', () => {
    expect(readLockedSha(uvLock, 'unknown-pkg')).toBeNull()
  })

  it('normalizes hyphens to underscores for matching', () => {
    const lock = [
      '[[package]]',
      'name = "roxabi_nats"',
      'source = { git = "https://github.com/Roxabi/roxabi-nats", rev = "aaabbbcccdddeeefffaaabbbcccdddeeefffaaab" }',
    ].join('\n')
    expect(readLockedSha(lock, 'roxabi-nats')).toBe('aaabbbcccdddeeefffaaabbbcccdddeeefffaaab')
  })

  it('returns null when source has no rev field', () => {
    const lock = ['[[package]]', 'name = "roxabi-nats"', 'source = { url = "https://example.com/pkg.tar.gz" }'].join(
      '\n',
    )
    expect(readLockedSha(lock, 'roxabi-nats')).toBeNull()
  })
})

// ─── resolveTagAtSha ─────────────────────────────────────────────────────────

describe('resolveTagAtSha', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'
  const gitUrl = 'https://github.com/Roxabi/roxabi-nats'

  function makeDeps(lsRemoteOutput: string): Pick<Deps, 'run'> {
    return {
      run: vi.fn().mockResolvedValue(lsRemoteOutput),
    }
  }

  it('returns monorepo-style tag when SHA matches', async () => {
    const lsRemote = [
      `${sha}\trefs/tags/roxabi-nats/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/roxabi-nats/v1.2.3`,
    ].join('\n')
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)
    expect(tag).toBe('roxabi-nats/v1.2.3')
  })

  it('prefers monorepo-style tag over bare vX.Y.Z when both match', async () => {
    const lsRemote = [
      `${sha}\trefs/tags/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/v1.2.3`,
      `${sha}\trefs/tags/roxabi-nats/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/roxabi-nats/v1.2.3`,
    ].join('\n')
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)
    expect(tag).toBe('roxabi-nats/v1.2.3')
  })

  it('falls back to bare vX.Y.Z tag when no monorepo tag matches', async () => {
    const lsRemote = [`${sha}\trefs/tags/v0.5.0^{}`, `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/v0.5.0`].join(
      '\n',
    )
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'some-pkg', deps)
    expect(tag).toBe('v0.5.0')
  })

  it('returns null when SHA has no matching tag', async () => {
    const lsRemote = [`0000000000000000000000000000000000000000\trefs/tags/v1.0.0^{}`].join('\n')
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)
    expect(tag).toBeNull()
  })

  it('throws with remote details when ls-remote fails (network/auth/timeout)', async () => {
    const deps: Pick<Deps, 'run'> = {
      run: vi.fn().mockRejectedValue(new Error('Connection timed out')),
    }
    await expect(resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)).rejects.toThrow(
      /Failed to query.*for tags at.*Connection timed out/,
    )
  })

  it('returns null when ls-remote output is empty', async () => {
    const deps = makeDeps('')
    const tag = await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)
    expect(tag).toBeNull()
  })

  it('ignores non-release tags (no vX.Y.Z pattern)', async () => {
    const lsRemote = [`${sha}\trefs/tags/latest^{}`, `${sha}\trefs/tags/staging^{}`].join('\n')
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)
    expect(tag).toBeNull()
  })

  it('picks highest semver tag numerically, not lexicographically', async () => {
    // lexicographic would pick v1.9.0 over v1.10.0 — numeric must pick v1.10.0
    const lsRemote = [
      `${sha}\trefs/tags/v1.10.0^{}`,
      `${sha}\trefs/tags/v1.9.0^{}`,
      `${sha}\trefs/tags/v1.2.0^{}`,
    ].join('\n')
    const deps = makeDeps(lsRemote)
    const tag = await resolveTagAtSha(gitUrl, sha, 'some-pkg', deps)
    expect(tag).toBe('v1.10.0')
  })
})

// ─── rewritePyproject ─────────────────────────────────────────────────────────

describe('rewritePyproject', () => {
  it('rewrites branch= to tag= in inline table form', () => {
    const input = [
      '[tool.uv.sources]',
      'roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }',
    ].join('\n')
    const output = rewritePyproject(input, 'roxabi-nats', 'roxabi-nats/v1.2.3')
    expect(output).toContain('tag = "roxabi-nats/v1.2.3"')
    expect(output).not.toContain('branch =')
  })

  it('rewrites only the target package, not others', () => {
    const input = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      'libB = { git = "https://github.com/org/libB", branch = "staging" }',
    ].join('\n')
    const output = rewritePyproject(input, 'libA', 'v2.0.0')
    expect(output).toContain('libA = { git = "https://github.com/org/libA", tag = "v2.0.0" }')
    expect(output).toContain('libB = { git = "https://github.com/org/libB", branch = "staging" }')
  })

  it('rewrites branch= to tag= in sub-table form', () => {
    const input = [
      '[tool.uv.sources.roxabi-nats]',
      'git = "https://github.com/Roxabi/roxabi-nats"',
      'branch = "staging"',
    ].join('\n')
    const output = rewritePyproject(input, 'roxabi-nats', 'roxabi-nats/v1.2.3')
    expect(output).toContain('tag = "roxabi-nats/v1.2.3"')
    expect(output).not.toContain('branch =')
  })

  it('preserves lines outside sources section unchanged', () => {
    const input = [
      '[project]',
      'name = "myapp"',
      'version = "1.0.0"',
      '',
      '[tool.uv.sources]',
      'roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }',
      '',
      '[tool.ruff]',
      'line-length = 120',
    ].join('\n')
    const output = rewritePyproject(input, 'roxabi-nats', 'v1.2.3')
    expect(output).toContain('[project]')
    expect(output).toContain('name = "myapp"')
    expect(output).toContain('[tool.ruff]')
    expect(output).toContain('line-length = 120')
  })

  it('does not mutate the input string', () => {
    const input = '[tool.uv.sources]\nlibA = { git = "url", branch = "staging" }\n'
    const original = input
    rewritePyproject(input, 'libA', 'v1.0.0')
    expect(input).toBe(original)
  })
})

// ─── buildPinSwapPlan ─────────────────────────────────────────────────────────

describe('buildPinSwapPlan', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'

  function makeDeps(overrides: Partial<Deps> = {}): Deps {
    const pyproject = [
      '[tool.uv.sources]',
      `roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }`,
    ].join('\n')

    const uvLock = [
      '[[package]]',
      'name = "roxabi-nats"',
      `source = { git = "https://github.com/Roxabi/roxabi-nats", rev = "${sha}" }`,
    ].join('\n')

    const lsRemote = [
      `${sha}\trefs/tags/roxabi-nats/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/roxabi-nats/v1.2.3`,
    ].join('\n')

    return {
      readFile: vi.fn((path: string) => {
        if (path.endsWith('pyproject.toml')) return pyproject
        if (path.endsWith('uv.lock')) return uvLock
        throw new Error(`unexpected readFile: ${path}`)
      }),
      writeFile: vi.fn(),
      run: vi.fn().mockResolvedValue(lsRemote),
      ...overrides,
    }
  }

  it('returns empty candidates when no branch= git deps', async () => {
    const deps = makeDeps({
      readFile: vi.fn(() => '[tool.uv.sources]\nlibA = { url = "https://example.com/a.tar.gz" }\n'),
    })
    const plan = await buildPinSwapPlan('/repo', deps)
    expect(plan.candidates).toHaveLength(0)
  })

  it('builds a plan with resolved candidate', async () => {
    const deps = makeDeps()
    const plan = await buildPinSwapPlan('/repo', deps)
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]).toMatchObject({
      name: 'roxabi-nats',
      branch: 'staging',
      sha,
      tag: 'roxabi-nats/v1.2.3',
    })
  })

  it('throws when SHA not found in uv.lock', async () => {
    const deps = makeDeps({
      readFile: vi.fn((path: string) => {
        if (path.endsWith('pyproject.toml')) {
          return '[tool.uv.sources]\nroxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }\n'
        }
        return '[[package]]\nname = "other"\nsource = { url = "x" }\n'
      }),
    })
    await expect(buildPinSwapPlan('/repo', deps)).rejects.toThrow(/no rev found in uv\.lock/)
  })

  it('throws with actionable message when no tag at SHA', async () => {
    const deps = makeDeps({
      run: vi.fn().mockResolvedValue(`0000000000000000000000000000000000000000\trefs/tags/v1.0.0^{}`),
    })
    await expect(buildPinSwapPlan('/repo', deps)).rejects.toThrow(/Cut a release tag.*upstream first/)
  })
})

// ─── applyPinSwap ─────────────────────────────────────────────────────────────

describe('applyPinSwap', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'
  const pyproject = [
    '[tool.uv.sources]',
    'roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }',
  ].join('\n')

  const plan: PinSwapPlan = {
    candidates: [
      {
        name: 'roxabi-nats',
        gitUrl: 'https://github.com/Roxabi/roxabi-nats',
        branch: 'staging',
        sha,
        tag: 'roxabi-nats/v1.2.3',
      },
    ],
  }

  it('returns written=false when plan has no candidates', async () => {
    const deps: Deps = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      run: vi.fn().mockResolvedValue(''),
    }
    const result = await applyPinSwap('/repo', { candidates: [] }, deps)
    expect(result).toEqual({ written: false, staged: false })
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it('writes rewritten pyproject.toml', async () => {
    const writes: [string, string][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn((path, content) => writes.push([path, content])),
      run: vi.fn().mockResolvedValue(''),
    }
    await applyPinSwap('/repo', plan, deps)
    expect(writes).toHaveLength(1)
    const [path, content] = writes[0]
    expect(path).toBe('/repo/pyproject.toml')
    expect(content).toContain('tag = "roxabi-nats/v1.2.3"')
    expect(content).not.toContain('branch =')
  })

  it('runs uv lock to regenerate lock file', async () => {
    const runs: string[][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn(),
      run: vi.fn(async (cmd: string[]) => {
        runs.push(cmd)
        return ''
      }),
    }
    await applyPinSwap('/repo', plan, deps)
    expect(runs).toContainEqual(['uv', 'lock'])
  })

  it('stages pyproject.toml and uv.lock', async () => {
    const runs: string[][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn(),
      run: vi.fn(async (cmd: string[]) => {
        runs.push(cmd)
        return ''
      }),
    }
    await applyPinSwap('/repo', plan, deps)
    expect(runs).toContainEqual(['git', 'add', 'pyproject.toml', 'uv.lock'])
  })

  it('returns written=true and staged=true on success', async () => {
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn(),
      run: vi.fn().mockResolvedValue(''),
    }
    const result = await applyPinSwap('/repo', plan, deps)
    expect(result).toEqual({ written: true, staged: true })
  })

  it('restores original pyproject.toml and rethrows when uv lock fails', async () => {
    const writes: [string, string][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn((path, content) => writes.push([path, content])),
      run: vi.fn(async (cmd: string[]) => {
        if (cmd[0] === 'uv') throw new Error('lock resolution failed')
        return ''
      }),
    }
    await expect(applyPinSwap('/repo', plan, deps)).rejects.toThrow(
      /uv lock failed; pyproject\.toml restored: lock resolution failed/,
    )
    // writeFile called twice: once to write new content, once to restore original
    expect(writes).toHaveLength(2)
    const [, restoredContent] = writes[1]
    expect(restoredContent).toBe(pyproject)
  })
})

// ─── formatPlan ───────────────────────────────────────────────────────────────

describe('formatPlan', () => {
  it('reports skip message for empty plan', () => {
    const out = formatPlan({ candidates: [] })
    expect(out).toContain('no branch= git deps found')
  })

  it('shows candidate diff for non-empty plan', () => {
    const plan: PinSwapPlan = {
      candidates: [
        {
          name: 'roxabi-nats',
          gitUrl: 'https://github.com/Roxabi/roxabi-nats',
          branch: 'staging',
          sha: 'abc123def456abc123def456abc123def456abc1',
          tag: 'roxabi-nats/v1.2.3',
        },
      ],
    }
    const out = formatPlan(plan)
    expect(out).toContain('roxabi-nats')
    expect(out).toContain('branch=staging')
    expect(out).toContain('tag=roxabi-nats/v1.2.3')
    expect(out).toContain('abc123def456')
  })
})
