import { expect, it } from 'vitest'
import { readNativePullRequestFacts } from '../github-workflow/native-facts.ts'

it('reports the actual merge commit separately from the reviewed head', async () => {
  const head = 'a'.repeat(40)
  const merge = 'b'.repeat(40)
  const result = await readNativePullRequestFacts('acme/app', 7, {
    cwd: '/fixture',
    gh: async () =>
      JSON.stringify({
        number: 7,
        state: 'MERGED',
        headRefOid: head,
        headRefName: 'feature/test',
        baseRefName: 'main',
        baseRefOid: 'c'.repeat(40),
        mergeCommit: { oid: merge },
        author: { login: 'operator' },
      }),
  })
  expect(result.head).toBe(head)
  expect(result.mergeCommit).toBe(merge)
})

it('refuses a merged PR when its actual merge commit is missing', async () => {
  await expect(
    readNativePullRequestFacts('acme/app', 7, {
      cwd: '/fixture',
      gh: async () =>
        JSON.stringify({
          number: 7,
          state: 'MERGED',
          headRefOid: 'a'.repeat(40),
          headRefName: 'feature/test',
          baseRefName: 'main',
          baseRefOid: 'c'.repeat(40),
          mergeCommit: null,
          author: { login: 'operator' },
        }),
    }),
  ).rejects.toThrow()
})
