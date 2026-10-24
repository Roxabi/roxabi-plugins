import { describe, expect, it, vi } from 'vitest'
import { applyPinSwap, buildPinSwapPlan, formatPlan } from '../lib/pin-swap'
import type { Deps, PinSwapPlan } from '../lib/pin-swap-contract'
import { parseUvGitDeps, readLockedSha, rewritePyproject } from '../lib/pin-swap-source'
import { resolveTagAtSha } from '../lib/pin-swap-tags'
import { pinSwapDeps } from './promote-test-support'

describe('parseUvGitDeps', () => {
  it('returns no candidates outside a sources table', () => {
    expect(parseUvGitDeps('[tool.poetry]\nname = "myapp"\n')).toEqual([])
  })

  it('returns no candidates for url or tag sources', () => {
    const toml = [
      '[tool.uv.sources]',
      'archive = { url = "https://example.com/lib.tar.gz" }',
      'released = { git = "https://github.com/org/released", tag = "v1.0.0" }',
    ].join('\n')
    expect(parseUvGitDeps(toml)).toEqual([])
  })

  it('collects inline branch pins in source order', () => {
    const toml = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      'libB = { git = "https://github.com/org/libB", branch = "dev" }',
    ].join('\n')
    expect(parseUvGitDeps(toml)).toEqual([
      { name: 'libA', source: { git: 'https://github.com/org/libA', branch: 'staging' } },
      { name: 'libB', source: { git: 'https://github.com/org/libB', branch: 'dev' } },
    ])
  })

  it('collects a branch pin from a sub-table', () => {
    const toml = [
      '[tool.uv.sources.roxabi-nats]',
      'git = "https://github.com/Roxabi/roxabi-nats"',
      'branch = "staging"',
    ].join('\n')
    expect(parseUvGitDeps(toml)).toEqual([
      {
        name: 'roxabi-nats',
        source: { git: 'https://github.com/Roxabi/roxabi-nats', branch: 'staging' },
      },
    ])
  })

  it('stops at an unrelated section', () => {
    const toml = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      '[tool.ruff]',
      'libB = { git = "https://github.com/org/libB", branch = "staging" }',
    ].join('\n')
    expect(parseUvGitDeps(toml)).toEqual([
      { name: 'libA', source: { git: 'https://github.com/org/libA', branch: 'staging' } },
    ])
  })
})

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

  it('reads a package SHA and normalizes hyphens', () => {
    expect(readLockedSha(uvLock, 'roxabi-nats')).toBe('abc123def456abc123def456abc123def456abc1')
    expect(readLockedSha(uvLock, 'other-lib')).toBe('111222333444111222333444111222333444abcd')
    expect(
      readLockedSha(
        '[[package]]\nname = "roxabi_nats"\nsource = { git = "url", rev = "aaabbbcccdddeeefffaaabbbcccdddeeefffaaab" }',
        'roxabi-nats',
      ),
    ).toBe('aaabbbcccdddeeefffaaabbbcccdddeeefffaaab')
  })

  it('refuses unknown and unpinned packages', () => {
    expect(readLockedSha(uvLock, 'unknown-pkg')).toBeNull()
    expect(
      readLockedSha(
        '[[package]]\nname = "roxabi-nats"\nsource = { url = "https://example.com/pkg.tar.gz" }',
        'roxabi-nats',
      ),
    ).toBeNull()
  })
})

describe('resolveTagAtSha', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'
  const gitUrl = 'https://github.com/Roxabi/roxabi-nats'
  const runFor = (output: string): Pick<Deps, 'run'> => ({ run: vi.fn().mockResolvedValue(output) })

  it('prefers a matching component tag over a matching bare tag', async () => {
    const output = [
      `${sha}\trefs/tags/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/v1.2.3`,
      `${sha}\trefs/tags/roxabi-nats/v1.2.3^{}`,
      `deadbeef0000deadbeef0000deadbeef0000dead\trefs/tags/roxabi-nats/v1.2.3`,
    ].join('\n')
    expect(await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', runFor(output))).toBe('roxabi-nats/v1.2.3')
  })

  it('chooses the highest matching bare semver numerically', async () => {
    const output = [`${sha}\trefs/tags/v1.10.0^{}`, `${sha}\trefs/tags/v1.9.0^{}`, `${sha}\trefs/tags/v1.2.0^{}`].join(
      '\n',
    )
    expect(await resolveTagAtSha(gitUrl, sha, 'some-pkg', runFor(output))).toBe('v1.10.0')
  })

  it('returns null for empty, unmatched, and non-release tag output', async () => {
    expect(await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', runFor(''))).toBeNull()
    expect(
      await resolveTagAtSha(
        gitUrl,
        sha,
        'roxabi-nats',
        runFor('0000000000000000000000000000000000000000\trefs/tags/v1.0.0^{}'),
      ),
    ).toBeNull()
    expect(await resolveTagAtSha(gitUrl, sha, 'roxabi-nats', runFor(`${sha}\trefs/tags/latest^{}`))).toBeNull()
  })

  it('surfaces remote readback failure', async () => {
    const deps: Pick<Deps, 'run'> = { run: vi.fn().mockRejectedValue(new Error('Connection timed out')) }
    await expect(resolveTagAtSha(gitUrl, sha, 'roxabi-nats', deps)).rejects.toThrow()
  })
})

describe('rewritePyproject', () => {
  it('replaces only the selected inline branch source', () => {
    const input = [
      '[tool.uv.sources]',
      'libA = { git = "https://github.com/org/libA", branch = "staging" }',
      'libB = { git = "https://github.com/org/libB", branch = "staging" }',
    ].join('\n')
    expect(rewritePyproject(input, 'libA', 'v2.0.0')).toBe(
      [
        '[tool.uv.sources]',
        'libA = { git = "https://github.com/org/libA", tag = "v2.0.0" }',
        'libB = { git = "https://github.com/org/libB", branch = "staging" }',
      ].join('\n'),
    )
  })

  it('replaces a selected sub-table branch and preserves unrelated text', () => {
    const input = [
      '[project]',
      'name = "myapp"',
      '[tool.uv.sources.roxabi-nats]',
      'git = "https://github.com/Roxabi/roxabi-nats"',
      'branch = "staging"',
      '[tool.ruff]',
      'line-length = 120',
    ].join('\n')
    expect(rewritePyproject(input, 'roxabi-nats', 'roxabi-nats/v1.2.3')).toBe(
      [
        '[project]',
        'name = "myapp"',
        '[tool.uv.sources.roxabi-nats]',
        'git = "https://github.com/Roxabi/roxabi-nats"',
        'tag = "roxabi-nats/v1.2.3"',
        '[tool.ruff]',
        'line-length = 120',
      ].join('\n'),
    )
  })
})

describe('buildPinSwapPlan', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'

  it('does not query tags when no mutable git source exists', async () => {
    const deps = pinSwapDeps(sha, {
      readFile: vi.fn(() => '[tool.uv.sources]\nlibA = { url = "https://example.com/a.tar.gz" }\n'),
    })
    await expect(buildPinSwapPlan('/repo', deps)).resolves.toEqual({ candidates: [] })
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('binds the locked revision to the matching release tag', async () => {
    const plan = await buildPinSwapPlan('/repo', pinSwapDeps(sha))
    expect(plan).toEqual({
      candidates: [
        {
          name: 'roxabi-nats',
          gitUrl: 'https://github.com/Roxabi/roxabi-nats',
          branch: 'staging',
          sha,
          tag: 'roxabi-nats/v1.2.3',
        },
      ],
    })
  })

  it('refuses unbound revisions and revisions without a release tag', async () => {
    const unbound = pinSwapDeps(sha, {
      readFile: vi.fn((path: string) =>
        path.endsWith('pyproject.toml')
          ? '[tool.uv.sources]\nroxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }\n'
          : '[[package]]\nname = "other"\nsource = { url = "x" }\n',
      ),
    })
    await expect(buildPinSwapPlan('/repo', unbound)).rejects.toThrow()
    const noTag = pinSwapDeps(sha, {
      run: vi.fn().mockResolvedValue('0000000000000000000000000000000000000000\trefs/tags/v1.0.0^{}'),
    })
    await expect(buildPinSwapPlan('/repo', noTag)).rejects.toThrow()
  })
})

describe('applyPinSwap', () => {
  const sha = 'abc123def456abc123def456abc123def456abc1'
  const pyproject =
    '[tool.uv.sources]\nroxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }'
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

  it('does not write or invoke commands for an empty plan', async () => {
    const deps: Deps = { readFile: vi.fn(), writeFile: vi.fn(), run: vi.fn().mockResolvedValue('') }
    await expect(applyPinSwap('/repo', { candidates: [] }, deps)).resolves.toEqual({ written: false, staged: false })
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('writes the rewritten source, locks, then stages both artifacts', async () => {
    const writes: [string, string][] = []
    const runs: string[][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn((path, content) => writes.push([path, content])),
      run: vi.fn(async (cmd: string[]) => {
        runs.push(cmd)
        return ''
      }),
    }
    await expect(applyPinSwap('/repo', plan, deps)).resolves.toEqual({ written: true, staged: true })
    expect(writes).toEqual([
      [
        '/repo/pyproject.toml',
        '[tool.uv.sources]\nroxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", tag = "roxabi-nats/v1.2.3" }',
      ],
    ])
    expect(runs).toEqual([
      ['uv', 'lock'],
      ['git', 'add', 'pyproject.toml', 'uv.lock'],
    ])
  })

  it('restores the original source and does not stage when lock regeneration fails', async () => {
    const writes: [string, string][] = []
    const deps: Deps = {
      readFile: vi.fn(() => pyproject),
      writeFile: vi.fn((path, content) => writes.push([path, content])),
      run: vi.fn(async (cmd: string[]) => {
        if (cmd[0] === 'uv') throw new Error('lock resolution failed')
        return ''
      }),
    }
    await expect(applyPinSwap('/repo', plan, deps)).rejects.toThrow()
    expect(writes).toEqual([
      [
        '/repo/pyproject.toml',
        '[tool.uv.sources]\nroxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", tag = "roxabi-nats/v1.2.3" }',
      ],
      ['/repo/pyproject.toml', pyproject],
    ])
    expect(deps.run).toHaveBeenCalledTimes(1)
  })
})

describe('formatPlan', () => {
  it('renders either a no-op notice or the resolved pin provenance', () => {
    expect(formatPlan({ candidates: [] })).toContain('no branch= git deps found')
    expect(
      formatPlan({
        candidates: [
          {
            name: 'roxabi-nats',
            gitUrl: 'https://github.com/Roxabi/roxabi-nats',
            branch: 'staging',
            sha: 'abc123def456abc123def456abc123def456abc1',
            tag: 'roxabi-nats/v1.2.3',
          },
        ],
      }),
    ).toContain('branch=staging')
  })
})
