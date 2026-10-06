import { describe, expect, it } from 'vitest'
import { epicDiffRange, type MergedChild, postMergeArgv } from './epic-close'

const sha = (digit: string) => digit.repeat(40)
const merged = (number: number, base: string, merge: string, at: string | null) => ({
  number,
  baseSha: sha(base),
  mergeSha: sha(merge),
  mergedAt: at,
})

describe('epicDiffRange', () => {
  it('returns one baseSha..mergeSha per merged child, skipping unmerged children, ending at the last merge', () => {
    expect(
      epicDiffRange([
        merged(1, '1', '2', '2026-09-01T10:00:00Z'),
        { number: 2, baseSha: sha('3'), mergeSha: null, mergedAt: null },
        merged(3, '4', '5', '2026-09-02T10:00:00Z'),
      ]),
    ).toEqual({ range: `${sha('1')}..${sha('2')},${sha('4')}..${sha('5')}`, end: sha('5') })
  })

  it('orders by merge time, not by the order given, and breaks a tie by issue number', () => {
    expect(
      epicDiffRange([
        merged(5, 'c', 'd', '2026-09-03T10:00:00Z'),
        merged(9, 'a', 'b', '2026-09-01T10:00:00Z'),
        merged(7, 'e', 'f', '2026-09-01T10:00:00Z'),
      ]),
    ).toEqual({ range: `${sha('e')}..${sha('f')},${sha('a')}..${sha('b')},${sha('c')}..${sha('d')}`, end: sha('d') })
  })

  it('leaves a foreign merge between two children in no element', () => {
    // #1 merged commit 2 onto base 1. A foreign merge (commit 4) then moved the base to 6; #2 landed on 6.
    const result = epicDiffRange([
      merged(1, '1', '2', '2026-09-01T10:00:00Z'),
      merged(2, '6', '3', '2026-09-02T10:00:00Z'),
    ])
    expect(result).toEqual({ range: `${sha('1')}..${sha('2')},${sha('6')}..${sha('3')}`, end: sha('3') })
    expect('range' in result && result.range).not.toContain(sha('4'))
  })

  it('keeps a single child as sha..sha', () => {
    expect(epicDiffRange([merged(1, '1', '2', '2026-09-01T10:00:00Z')])).toEqual({
      range: `${sha('1')}..${sha('2')}`,
      end: sha('2'),
    })
  })

  it('refuses a range when nothing has merged', () => {
    expect(epicDiffRange([{ number: 1, baseSha: sha('1'), mergeSha: null, mergedAt: null }])).toEqual({
      error: 'no merged children',
    })
    expect(epicDiffRange([])).toEqual({ error: 'no merged children' })
  })

  it.each<[string, Partial<MergedChild>]>([
    ['a missing base', { baseSha: null }],
    ['a base that is not a full sha', { baseSha: 'base1' }],
    ['an uppercase base', { baseSha: 'A'.repeat(40) }],
    ['a merge commit that is not a full sha', { mergeSha: 'abc1234' }],
    ['a missing merge time', { mergedAt: null }],
  ])('refuses the whole range when any merged child has %s', (_name, over) => {
    const bad = { ...merged(2, '3', '4', '2026-09-02T10:00:00Z'), ...over }
    expect(epicDiffRange([merged(1, '1', '2', '2026-09-01T10:00:00Z'), bad])).toEqual({ error: expect.any(String) })
    expect(epicDiffRange([bad, merged(1, '1', '2', '2026-09-01T10:00:00Z')])).toEqual({ error: expect.any(String) })
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
