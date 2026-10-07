import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { epicCoverage } from './epic-close'

/**
 * Hermetic: no GIT_* from the caller, no user or system git config. Real
 * two-parent merges, not a stubbed span.
 */
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function names(cwd: string, from: string, to: string): string[] {
  const out = git(cwd, 'diff', '--name-only', '--no-ext-diff', from, to, '--')
  return out ? out.split('\n') : []
}

describe('epicCoverage against real merges', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('excludes a foreign merge that the first-base..last-merge span includes', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-epic-coverage-')))
    git(root, 'init', '-q', '-b', 'main')
    writeFileSync(join(root, 'README.md'), 'base\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-qm', 'chore: base')

    git(root, 'switch', '-q', '-c', 'feat/2-child-one')
    writeFileSync(join(root, 'child1.txt'), 'one\n')
    git(root, 'add', 'child1.txt')
    git(root, 'commit', '-qm', 'feat(x): child one (#2)')
    const tip1 = git(root, 'rev-parse', 'HEAD')
    git(root, 'switch', '-q', 'main')
    git(root, 'merge', '--no-ff', tip1, '-m', 'Merge child one')
    const merge1 = git(root, 'rev-parse', 'HEAD')
    const parent1 = git(root, 'rev-parse', `${merge1}^1`)
    const second1 = git(root, 'rev-parse', `${merge1}^2`)

    writeFileSync(join(root, 'foreign.txt'), 'foreign\n')
    git(root, 'add', 'foreign.txt')
    git(root, 'commit', '-qm', 'chore: foreign')

    git(root, 'switch', '-q', '-c', 'feat/3-child-two')
    writeFileSync(join(root, 'child2.txt'), 'two\n')
    git(root, 'add', 'child2.txt')
    git(root, 'commit', '-qm', 'feat(x): child two (#3)')
    const tip2 = git(root, 'rev-parse', 'HEAD')
    git(root, 'switch', '-q', 'main')
    git(root, 'merge', '--no-ff', tip2, '-m', 'Merge child two')
    const merge2 = git(root, 'rev-parse', 'HEAD')
    const parent2 = git(root, 'rev-parse', `${merge2}^1`)
    const second2 = git(root, 'rev-parse', `${merge2}^2`)

    expect(parent1).not.toBe(second1)
    expect(second1).toBe(tip1)
    expect(parent2).not.toBe(second2)
    expect(second2).toBe(tip2)

    const reversed = [
      { number: 3, baseSha: parent2, mergeSha: merge2, mergedAt: '2026-09-30T12:00:00Z' },
      { number: 2, baseSha: parent1, mergeSha: merge1, mergedAt: '2026-09-30T10:00:00Z' },
    ]
    const forward = [...reversed].reverse()
    const got = epicCoverage(reversed)
    expect(got).toEqual(epicCoverage(forward))
    expect(got).toEqual({
      diffs: [
        { number: 2, firstParent: parent1, merge: merge1 },
        { number: 3, firstParent: parent2, merge: merge2 },
      ],
      coverage: createHash('sha256')
        .update(parent1 + merge1 + parent2 + merge2)
        .digest('hex'),
    })
    if (!('diffs' in got)) throw new Error('coverage failed')
    expect(got.coverage).not.toBe(
      createHash('sha256')
        .update(parent1 + merge2)
        .digest('hex'),
    )
    expect(got.diffs[0]?.firstParent).toBe(parent1)
    expect(got.diffs[0]?.firstParent).not.toBe(second1)
    expect(got.diffs[1]?.firstParent).toBe(parent2)
    expect(got.diffs[1]?.firstParent).not.toBe(second2)

    expect(names(root, got.diffs[0]?.firstParent ?? '', got.diffs[0]?.merge ?? '')).toEqual(['child1.txt'])
    expect(names(root, got.diffs[1]?.firstParent ?? '', got.diffs[1]?.merge ?? '')).toEqual(['child2.txt'])
    expect(names(root, parent1, merge2)).toContain('foreign.txt')
    expect(names(root, parent1, merge1)).not.toContain('foreign.txt')
    expect(names(root, parent2, merge2)).not.toContain('foreign.txt')
  })
})
