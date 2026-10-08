import { describe, expect, it } from 'vitest'
import { epicDiffRange, postMergeArgv } from './epic-close'

describe('epicDiffRange', () => {
  it('spans the first merged child base to the last merge commit, skipping unmerged children', () => {
    expect(
      epicDiffRange([
        { number: 1, baseSha: 'base1', mergeSha: 'm1' },
        { number: 2, baseSha: 'base2', mergeSha: null },
        { number: 3, baseSha: 'base3', mergeSha: 'm3' },
      ]),
    ).toEqual({ range: 'base1..m3' })
  })

  it('refuses a range when nothing has merged', () => {
    expect(epicDiffRange([{ number: 1, baseSha: 'base1', mergeSha: null }])).toEqual({ error: 'no merged children' })
    expect(epicDiffRange([])).toEqual({ error: 'no merged children' })
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
