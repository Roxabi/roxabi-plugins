import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import { closure, effectGuard, installed, numberOf, prepare } from '../../testing/framing-runtime-fixture.ts'

it('follows a disconnected member identity to its intent home only when the framing fact is complete and trusted', async () => {
  const native = nativeGitHub()
  const framing = await installed(native)
  const input = closure()
  input.members = input.members.slice(0, 2)
  input.edges = []
  input.coverage = []
  input.foundations = []
  const framed = await framing.operations.frame(await prepare(framing.operations, input), effectGuard().guard)
  if (framed.status !== 'written') throw new Error(`Expected complete aggregate: ${JSON.stringify(framed)}`)
  const member = framed.value.members.find((item) => item.key === 'foundation')
  if (!member) throw new Error('Missing disconnected member')
  const initial = await framing.operations.readUw(member.scope)
  const own = initial.histories.find((history) => history.source.scope.target === member.scope.target)
  if (!own) throw new Error('Missing member history')
  const binding = own.operations.find(
    (operation) => operation.record?.kind === 'framing-receipt' && operation.record.payload.phase === 'member-binding',
  )
  const identity = own.operations.find(
    (operation) =>
      operation.record?.kind === 'spec-identity' && operation.record.payload.format === 'omp-build-spec-identity/2',
  )
  if (!binding || !identity || identity.parts.length !== 1)
    throw new Error('Expected actual single-part binding and identity')
  const bindingIds = new Set(binding.parts.map((part) => Number(part.nativeId)))
  const identityId = Number(identity.parts[0].nativeId)
  const rootEndpoint = `/issues/${numberOf(framed.value.root)}/comments`
  const memberEndpoint = `/issues/${numberOf(member.scope)}/comments`
  let mode: 'trusted' | 'foreign' | 'incomplete' = 'trusted'
  let rootReads = 0
  const gh: Gh = async (cwd, args) => {
    const endpoint = args.find((arg) => arg.includes('/comments')) ?? ''
    if (endpoint.includes(rootEndpoint) && !args.includes('POST')) rootReads += 1
    const response = await native.gh(cwd, args)
    if (!endpoint.includes(memberEndpoint) || args.includes('POST')) return response
    const comments = JSON.parse(response) as { id: number; body: string; user: { login: string } }[]
    return JSON.stringify(
      comments
        .filter((comment) => !bindingIds.has(comment.id))
        .map((comment) => {
          if (comment.id !== identityId) return comment
          if (mode === 'foreign') return { ...comment, user: { login: 'another-author' } }
          if (mode === 'incomplete') return { ...comment, body: comment.body.replace('part=1/1', 'part=1/2') }
          return comment
        }),
    )
  }
  const reader = await installed({ ...native, gh })
  const trusted = await reader.operations.readUw(member.scope)
  expect(rootReads).toBeGreaterThan(0)
  expect(trusted.histories.some((history) => history.source.scope.target === framed.value.root.target)).toBe(true)
  expect(trusted.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-binding-unregistered' })
  for (const next of ['foreign', 'incomplete'] as const) {
    mode = next
    rootReads = 0
    const observed = await reader.operations.readUw(member.scope)
    expect(rootReads).toBe(0)
    expect(observed.histories.some((history) => history.source.scope.target === framed.value.root.target)).toBe(false)
  }
})
