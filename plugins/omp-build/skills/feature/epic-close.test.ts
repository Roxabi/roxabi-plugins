import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { epicCoverage, postMergeArgv } from './epic-close'

const sha = (digit: string) => digit.repeat(40)

const child = (number: number, base: string, merge: string | null, at: string | null) => ({
  number,
  baseSha: base,
  mergeSha: merge,
  mergedAt: at,
})

describe('epicCoverage', () => {
  it('sorts by merge time then number and hashes the fixed-width pairs', () => {
    const input = [
      child(3, sha('3'), sha('c'), '2026-09-03T10:00:00Z'),
      child(1, sha('1'), sha('a'), '2026-09-01T10:00:00Z'),
      child(2, sha('2'), sha('b'), '2026-09-02T10:00:00Z'),
    ]
    const before = structuredClone(input)
    const got = epicCoverage(input)
    expect(input).toEqual(before)
    expect(got).toEqual({
      diffs: [
        { number: 1, firstParent: sha('1'), merge: sha('a') },
        { number: 2, firstParent: sha('2'), merge: sha('b') },
        { number: 3, firstParent: sha('3'), merge: sha('c') },
      ],
      coverage: createHash('sha256')
        .update(sha('1') + sha('a') + sha('2') + sha('b') + sha('3') + sha('c'))
        .digest('hex'),
    })
    expect(got).not.toHaveProperty('range')
  })

  it('returns the same coverage when the input order is reversed', () => {
    const forward = [
      child(1, sha('1'), sha('a'), '2026-09-01T10:00:00Z'),
      child(2, sha('2'), sha('b'), '2026-09-02T10:00:00Z'),
    ]
    expect(epicCoverage([...forward].reverse())).toEqual(epicCoverage(forward))
  })

  it('tie-breaks equal merge times by ticket number', () => {
    const at = '2026-09-01T10:00:00Z'
    expect(epicCoverage([child(4, sha('4'), sha('d'), at), child(2, sha('2'), sha('b'), at)])).toMatchObject({
      diffs: [
        { number: 2, firstParent: sha('2'), merge: sha('b') },
        { number: 4, firstParent: sha('4'), merge: sha('d') },
      ],
    })
  })

  it('rejects an unusable later child instead of dropping it', () => {
    const good = child(1, sha('1'), sha('a'), '2026-09-01T10:00:00Z')
    const later = child(2, sha('2'), sha('b'), '2026-09-02T10:00:00Z')
    expect(epicCoverage([good, { ...later, mergeSha: null }])).toEqual({ error: '#2 has no merge commit' })
    expect(epicCoverage([good, { ...later, baseSha: null }])).toEqual({ error: '#2 has no merge base' })
    expect(epicCoverage([good, { ...later, baseSha: 'base2' }])).toEqual({ error: '#2 has no merge base' })
    expect(epicCoverage([good, { ...later, mergeSha: sha('B') }])).toEqual({ error: '#2 has no merge commit' })
    expect(epicCoverage([good, { ...later, mergedAt: null }])).toEqual({ error: '#2 has no merge time' })
    expect(epicCoverage([good, { ...later, mergedAt: 'yesterday' }])).toEqual({ error: '#2 has no merge time' })
  })

  it('refuses when nothing was claimed merged', () => {
    expect(epicCoverage([])).toEqual({ error: 'no merged children' })
  })
})

describe('postMergeArgv', () => {
  const stack = (postMerge: unknown) => ({ release: { model: 'trunk', post_merge: postMerge } })

  it.each<[string, unknown]>([
    ['an empty stack.yml', null],
    ['no release section', { runtime: 'bun' }],
    ['release: null', { release: null }],
    ['no post_merge', { release: { model: 'trunk' } }],
    ['post_merge: null', stack(null)],
  ])('skips the hook on %s', (_name, doc) => {
    expect(postMergeArgv(doc)).toEqual({ skip: expect.any(String) })
  })

  it.each<[string, unknown]>([
    ['a string (it would need a shell)', stack('./scripts/post-merge.sh --flag')],
    ['an empty list', stack([])],
    ['a non-string element', stack(['./scripts/post-merge.sh', 3])],
    ['an empty argv[0]', stack([''])],
    ['a nested list', stack([['./scripts/post-merge.sh']])],
    ['a map', stack({ run: './scripts/post-merge.sh' })],
    ['a PATH lookup: bun', stack(['bun', 'run', 'post-merge'])],
    ['a PATH lookup: make', stack(['make'])],
    ['an absolute argv[0]', stack(['/usr/bin/make', 'post-merge'])],
    ['a stack that is not a map', 'release: x'],
    ['a release that is not a map', { release: 'trunk' }],
  ])('refuses %s', (_name, doc) => {
    expect(postMergeArgv(doc)).toEqual({ error: expect.any(String) })
  })

  it.each([[['./scripts/post-merge.sh', '--flag', 'two words']], [['scripts/post-merge.sh']]])(
    'accepts a relative path inside the repository: %j',
    (argv) => {
      expect(postMergeArgv(stack(argv))).toEqual({ argv })
    },
  )
})
