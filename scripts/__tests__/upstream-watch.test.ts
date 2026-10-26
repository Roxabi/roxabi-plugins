import { describe, expect, it, vi } from 'vitest'
import {
  changedWatchedPaths,
  compareIsTruncated,
  detectDrift,
  existingIssueAction,
  issueMarker,
  main,
  selectWatchedEntries,
  type WatchEntry,
} from '../upstream-watch'

const ENTRY: WatchEntry = {
  name: 'mattpocock-skills',
  owner: 'mattpocock',
  repo: 'skills',
  source: 'https://github.com/mattpocock/skills',
  baseline: 'b8be62ffacb0118fa3eaa29a0923c87c8c11985c',
  branch: 'main',
  watchedPaths: ['skills/productivity/grilling'],
}

const HEAD = 'abcd1234abcd1234abcd1234abcd1234abcd1234'

describe('selectWatchedEntries', () => {
  it('ignores curated entries that do not declare watched paths', () => {
    expect(
      selectWatchedEntries({
        curated_marketplaces: [
          { name: 'unwatched', source: 'https://github.com/example/unwatched', last_checked_commit: 'a', upstream_branch: 'main' },
          { ...ENTRY, watched_paths: ENTRY.watchedPaths, last_checked_commit: ENTRY.baseline, upstream_branch: ENTRY.branch },
        ],
      }).map((entry) => entry.name),
    ).toEqual(['mattpocock-skills'])
  })

  it('files exactly one fixture drift when only one watched path changed', () => {
    const entries = selectWatchedEntries({
      curated_marketplaces: [
        { name: 'unwatched', source: 'https://github.com/example/unwatched', last_checked_commit: 'a', upstream_branch: 'main' },
        { ...ENTRY, watched_paths: ENTRY.watchedPaths, last_checked_commit: ENTRY.baseline, upstream_branch: ENTRY.branch },
      ],
    })
    const drifts = entries.map((entry) => detectDrift(entry, HEAD, { files: [{ filename: 'skills/productivity/grilling/SKILL.md' }], commits: [{}] })).filter(Boolean)
    expect(drifts).toHaveLength(1)
  })
})

describe('detectDrift', () => {
  it('does not count a commit outside watched paths as drift', () => {
    expect(detectDrift(ENTRY, HEAD, { files: [{ filename: 'skills/productivity/handoff/SKILL.md' }], commits: [{}] })).toBeNull()
  })

  it('counts a commit inside a watched path as drift', () => {
    expect(detectDrift(ENTRY, HEAD, { files: [{ filename: 'skills/productivity/grilling/SKILL.md' }], commits: [{}] })).toMatchObject({
      changedPaths: ['skills/productivity/grilling'],
    })
  })

  it('keeps prefix matching within the watched path boundary', () => {
    expect(changedWatchedPaths(ENTRY.watchedPaths, [{ filename: 'skills/productivity/grilling-extra/SKILL.md' }])).toEqual([])
  })

  it('never treats a truncated compare response as clean', () => {
    const truncated = { files: Array.from({ length: 300 }, () => ({ filename: 'README.md' })), commits: [] }
    expect(compareIsTruncated(truncated)).toBe(true)
    expect(() => detectDrift(ENTRY, HEAD, truncated)).toThrow('requires path-scoped fallback')
    expect(detectDrift(ENTRY, HEAD, truncated, ENTRY.watchedPaths)).toMatchObject({ changedPaths: ENTRY.watchedPaths })
  })
})

describe('existingIssueAction', () => {
  it('refreshes the marker issue instead of duplicating it', () => {
    expect(existingIssueAction(ENTRY, [{ number: 42, body: `${issueMarker(ENTRY)}\nold report` }])).toBe('refresh')
  })
})

describe('main', () => {
  it('returns non-zero when detection cannot read its registry', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(main(['/definitely/missing/external-registry.json'], { GITHUB_REPOSITORY: 'Roxabi/roxabi-plugins' })).toBe(2)
    stderr.mockRestore()
  })
})
