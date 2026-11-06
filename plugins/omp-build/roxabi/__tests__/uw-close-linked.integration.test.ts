import { expect, it } from 'vitest'
import { scopeKey } from '../../engine/uw-graph.ts'
import { closeLinkedWorld } from './uw-close-linked-fixture.ts'

it.each([false, true])(
  'does not treat native closure as delivery when review proof disappears; closed=%s',
  async (closed) => {
    const f = await closeLinkedWorld({ closed })
    f.removeReview()
    const result = await f.operations.closeLinked(f.request)
    expect(result).toMatchObject({
      status: 'refused',
      diagnostics: [expect.objectContaining({ code: 'close-linked-completion-changed' })],
    })
    expect(f.state()).toEqual(
      closed ? { state: 'CLOSED', stateReason: 'COMPLETED' } : { state: 'OPEN', stateReason: null },
    )
  },
)

it('closes only the canonically bound complete UW and reads back its unchanged proof', async () => {
  const f = await closeLinkedWorld()
  expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
  const result = await f.operations.closeLinked(f.request)
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
  expect(result.status, JSON.stringify(result)).toBe('written')
  if (result.status !== 'written') throw new Error('Expected confirmed close')
  expect(result.value.completion.completions.get(scopeKey(f.leaf.uw))).toEqual(f.request.completion)
  expect(result.value.observation.graph.nodes.find((node) => node.uw.target === f.leaf.uw.target)?.native).toEqual(
    f.state(),
  )
})

it.each(['uw', 'pr', 'mandate', 'head', 'vector', 'sources'] as const)(
  'refuses a stale or foreign %s without closing',
  async (change) => {
    const f = await closeLinkedWorld()
    const r = f.request
    const request = (() => {
      switch (change) {
        case 'uw':
          return { ...r, uw: { ...r.uw, target: 'acme/app#43' } }
        case 'pr':
          return { ...r, pullRequest: { ...r.pullRequest, repository: 'other/app', target: 'other/app#142' } }
        case 'mandate':
          return { ...r, mandate: { ...r.mandate, recordId: 'foreign-mandate' } }
        case 'head':
          return { ...r, completion: { ...r.completion, code: { ...r.completion.code, head: f.leaf.base } } }
        case 'vector':
          return {
            ...r,
            completion: {
              ...r.completion,
              versionVector: [
                { ...r.completion.versionVector[0], version: 'e'.repeat(64) },
                ...r.completion.versionVector.slice(1),
              ] as typeof r.completion.versionVector,
            },
          }
        case 'sources':
          return {
            ...r,
            completion: {
              ...r.completion,
              sources: r.completion.sources.filter((source) => source.kind !== 'workflow-binding'),
            },
          }
      }
    })()
    const result = await f.operations.closeLinked(request)
    expect(result).toMatchObject({
      status: 'refused',
      diagnostics: [
        expect.objectContaining({
          code: change === 'vector' ? 'close-linked-completion-changed' : 'close-linked-binding-changed',
        }),
      ],
    })
    expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
  },
)

it('refuses when the actual PR head changes after preparation', async () => {
  const f = await closeLinkedWorld()
  f.changedHead()
  expect(await f.operations.closeLinked(f.request)).toMatchObject({
    status: 'refused',
    diagnostics: [expect.objectContaining({ code: 'close-linked-binding-changed' })],
  })
  expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
})

it('refuses a native state drift before the write rather than overwriting it', async () => {
  const f = await closeLinkedWorld({ race: 'native-before-write' })
  const result = await f.operations.closeLinked(f.request)
  expect(result).toMatchObject({ status: 'refused' })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })
})

it.each([
  ['proof-after-write', 'close-linked-readback-mismatch'],
  ['unreadable-after-write', 'readback-unconfirmed'],
  ['lost-effect', 'write-failed'],
] as const)('reports %s as partial while retaining the observed native effect', async (race, code) => {
  const f = await closeLinkedWorld({ race })
  const result = await f.operations.closeLinked(f.request)
  expect(result).toMatchObject({ status: 'partial', uw: f.leaf.uw, diagnostics: [expect.objectContaining({ code })] })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
})

it('accepts an already completed native state only with the current full proof', async () => {
  const f = await closeLinkedWorld({ closed: true })
  const result = await f.operations.closeLinked(f.request)
  expect(result.status, JSON.stringify(result)).toBe('written')
  if (result.status !== 'written') throw new Error('Expected current proof')
  expect(result.value.completion.completions.get(scopeKey(f.leaf.uw))).toEqual(f.request.completion)
  f.changedHead()
  expect(await f.operations.closeLinked(f.request)).toMatchObject({
    status: 'refused',
    diagnostics: [expect.objectContaining({ code: 'close-linked-binding-changed' })],
  })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
})
