import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { readCreatedUw } from '../uw-read-port.ts'

it('reads a created same-parent UW identity without reopening a sibling report PR and refuses delivery admission', async () => {
  const { identity } = sisterRecords()
  const visited: string[] = []
  const gh: Gh = async (_cwd, args) => {
    const endpoint = String(args[1] ?? '')
    visited.push(endpoint)
    if (endpoint.includes('/comments')) {
      if (!endpoint.includes('/issues/43/comments'))
        throw new Error(`old sibling or PR history unavailable: ${endpoint}`)
      return JSON.stringify([nativeComment(1, wire(identity))])
    }
    const values = args.flatMap((arg, index) => (arg === '-F' || arg === '-f' ? [args[index + 1] ?? ''] : []))
    const number = Number(values.find((value) => value.startsWith('number='))?.slice(7))
    if (![41, 42, 43].includes(number)) throw new Error(`unexpected graph issue ${number}`)
    const node = (n: number) => ({ number: n, repository: { nameWithOwner: 'acme/app' } })
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            title: `UW ${number}`,
            body: '',
            updatedAt: '2026-10-27T12:00:00Z',
            state: 'OPEN',
            stateReason: null,
            repository: { nameWithOwner: 'acme/app' },
            parent: number === 41 ? null : node(41),
            labels: page([]),
            subIssues: page(number === 41 ? [node(42), node(43)] : []),
            blockedBy: page([]),
          },
        },
      },
    })
  }
  const result = await readCreatedUw(
    { repository: 'acme/app', target: 'acme/app#43' },
    { cwd: '/fixture', gh, readAuthor: 'automation' },
  )
  expect(result.graph.status).toBe('complete')
  expect(result.graph.nodes.find((node) => node.uw.target === 'acme/app#43')?.parent?.target).toBe('acme/app#41')
  expect(result.identity.ok).toBe(true)
  if (result.identity.ok) expect(result.identity.value.head?.recordId).toBe(identity.recordId)
  expect(result.admission.deliverable.ok).toBe(false)
  expect(visited.filter((endpoint) => endpoint.includes('/comments'))).toEqual([
    expect.stringContaining('/issues/43/comments'),
  ])
})
