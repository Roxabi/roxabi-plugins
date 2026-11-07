import { createUwDeliveryFactReader } from '../../adapters/github-workflow/uw-delivery-facts.ts'
import type { Scope } from '../record-values.ts'

export function leafNativeFacts(uw: Scope, number: number, base: string, head: string, merge: string) {
  const commit = (sha: string, parents: string[]) => ({ sha, parents: parents.map((parent) => ({ sha: parent })) })
  const gitResponse = (args: readonly string[]) => {
    const path = args[1] ?? ''
    if (path === `repos/${uw.repository}/git/commits/${base}`) return JSON.stringify(commit(base, []))
    if (path === `repos/${uw.repository}/git/commits/${head}`) return JSON.stringify(commit(head, [base]))
    if (path === `repos/${uw.repository}/git/commits/${merge}`) return JSON.stringify(commit(merge, [base, head]))
    const comparisons = new Map([
      [`${base}\0${base}`, []],
      [`${head}\0${head}`, []],
      [`${merge}\0${merge}`, []],
      [`${base}\0${head}`, [commit(head, [base])]],
      [`${head}\0${merge}`, [commit(merge, [base, head])]],
      [`${base}\0${merge}`, [commit(head, [base]), commit(merge, [base, head])]],
    ])
    const range = new RegExp(
      `^repos/${uw.repository}/compare/([a-f0-9]{40})\\.\\.\\.([a-f0-9]{40})\\?per_page=100&page=1$`,
    ).exec(path)
    if (range) {
      const selected = comparisons.get(`${range[1]}\0${range[2]}`)
      if (!selected) throw new Error(`Undeclared comparison ${path}`)
      return JSON.stringify({
        status: selected.length === 0 ? 'identical' : 'ahead',
        total_commits: selected.length,
        commits: selected,
      })
    }
    throw new Error(`Undeclared native response: ${args.join(' ')}`)
  }
  const reader = createUwDeliveryFactReader({
    cwd: '/simulated',
    readAuthor: 'operator',
    gh: async (_cwd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql')
        return JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: number + 100,
                    headRefName: 'feat/42-save',
                    baseRefName: 'main',
                    repository: { nameWithOwner: uw.repository },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        })
      if (args[0] === 'pr' && args[1] === 'view')
        return JSON.stringify({
          number: number + 100,
          state: 'MERGED',
          headRefOid: head,
          headRefName: 'feat/42-save',
          baseRefName: 'main',
          baseRefOid: base,
          mergeCommit: { oid: merge },
          author: { login: 'operator' },
        })
      return gitResponse(args)
    },
  })
  return reader
}
