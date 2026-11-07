import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { decodeHistory, readGitHubHistory } from '../../dist/contracts.js'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import { closure, effectGuard, installed, prepare } from '../../testing/framing-runtime-fixture.ts'
import { readCreatedUw } from '../uw-read-port.ts'

it('reads a created same-parent UW identity without reading sibling history or asserting delivery', async () => {
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
  expect(result).not.toHaveProperty('admission')
  expect(result).not.toHaveProperty('accepted')
  expect(visited.filter((endpoint) => endpoint.includes('/comments'))).toEqual([
    expect.stringContaining('/issues/43/comments'),
  ])
})

it('reads a bound identity without admitting an aggregate whose result is missing', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const { guard } = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':binding'))
  const result = await operations.frame(await prepare(operations, closure()), guard)
  if (result.status !== 'partial' || result.root === null) throw new Error('Expected a partially framed root')
  const created = await readCreatedUw(result.root, { cwd: '/fixture', gh: native.gh, readAuthor: 'automation' })
  expect(created.identity.ok).toBe(true)
  expect(created).not.toHaveProperty('admission')
  expect(created).not.toHaveProperty('accepted')
  expect((await operations.readUw(result.root)).admission.aggregate).toMatchObject({
    status: 'held',
    code: 'framing-aggregate-incomplete',
  })
})

it.each([
  { status: 'invalid', ending: '' },
  { status: 'incomplete', ending: '\n' },
])('refuses a trusted $status framing envelope rather than treating it as a singleton', async ({ status, ending }) => {
  const native = nativeGitHub({ 41: { title: 'Partial framing' } })
  const scope = { repository: 'acme/app', target: 'acme/app#41' }
  native.comments
    .get(41)
    ?.push(
      nativeComment(
        1,
        `<!-- omp-build-record v=1 kind=framing-receipt id=partial operationId=partial-op part=1/2 data=e30 -->${ending}`,
      ),
    )
  const options = { cwd: '/fixture', gh: native.gh, readAuthor: 'automation' }
  // A missing header newline is invalid; the well-formed first part is incomplete.
  const history = decodeHistory(await readGitHubHistory(scope, options))
  expect(history.operations.map((operation) => operation.status)).toEqual([status])
  await expect(readCreatedUw(scope, options)).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'history-incomplete' })]),
  })
})
