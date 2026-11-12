import { expect, it } from 'vitest'
import { enumeratePullRequestsByBranch } from '../github-workflow/uw-delivery-enumeration.ts'

const node = (number: number, branch: string, base = 'main') => ({
  number,
  headRefName: branch,
  baseRefName: base,
  repository: { nameWithOwner: 'acme/app' },
})
const response = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) =>
  JSON.stringify({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } } })

it('queries all states and pages for distinct branches without filtering base', async () => {
  const calls: string[][] = []
  const result = await enumeratePullRequestsByBranch('acme/app', ['feature/a', 'feature/a', 'feature/b'], {
    cwd: '/fixture',
    gh: async (_cwd, args) => {
      calls.push(args)
      if (args.includes('branch=feature/b')) return response([node(3, 'feature/b')])
      if (args.includes('cursor=next')) return response([node(2, 'feature/a', 'retargeted')])
      return response([node(1, 'feature/a')], true, 'next')
    },
  })
  expect(result).toMatchObject({
    ok: true,
    value: [{ branch: 'feature/a' }, { base: 'retargeted' }, { branch: 'feature/b' }],
  })
  expect(calls).toHaveLength(3)
  for (const call of calls) {
    const query = call.find((arg) => arg.startsWith('query=')) ?? ''
    expect(query).toContain('states:[OPEN,CLOSED,MERGED]')
    expect(query).toContain('headRefName:$branch')
    expect(query).not.toContain('baseRefName:')
  }
})

it.each(['error', 'stalled', 'wrong-branch'] as const)(
  'refuses %s pages without reporting complete history',
  async (failure) => {
    let reads = 0
    const result = await enumeratePullRequestsByBranch('acme/app', ['feature/a'], {
      cwd: '/fixture',
      gh: async () => {
        reads++
        if (failure === 'error') throw new Error('unavailable')
        if (failure === 'wrong-branch') return response([node(1, 'feature/b')])
        return response([node(1, 'feature/a')], true, reads === 1 ? 'next' : 'next')
      },
    })
    expect(result.ok).toBe(false)
  },
)
