import { expect, it } from 'vitest'
import { scopeKey } from '../../engine/uw-graph.ts'
import { openBlockers } from '../../skills/feature/epic-progress.ts'
import { child } from '../../skills/feature/epic-transition.fixture.ts'
import { closeLinkedWorld } from './uw-close-linked-fixture.ts'

it('satisfies a managed open blocker when its actual delivery is complete', async () => {
  const f = await closeLinkedWorld()
  const fresh = await f.operations.readUw(f.leaf.uw)
  const dependency = fresh.completion.dependencies.get(scopeKey(f.leaf.uw))
  expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
  expect(fresh.observation.status).toBe('complete')
  expect(dependency).toMatchObject({
    basis: { kind: 'accepted-uw' },
    completion: { state: 'complete' },
    state: 'satisfied',
  })
})

it('holds a managed NOT_PLANNED blocker even when its independent delivery is complete', async () => {
  const f = await closeLinkedWorld({ race: 'native-before-write' })
  expect((await f.operations.closeLinked(f.request)).status).toBe('refused')
  const fresh = await f.operations.readUw(f.leaf.uw)
  const dependency = fresh.completion.dependencies.get(scopeKey(f.leaf.uw))
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })
  expect(fresh.observation.status).toBe('complete')
  expect(dependency).toMatchObject({ basis: { kind: 'accepted-uw' }, completion: { state: 'complete' }, state: 'held' })
  expect(dependency?.diagnostics.length).toBeGreaterThan(0)
})

it('retains the held managed blocker in epic progress despite its complete delivery', async () => {
  const f = await closeLinkedWorld({ race: 'native-before-write' })
  await f.operations.closeLinked(f.request)
  const fresh = await f.operations.readUw(f.leaf.uw)
  const dependency = fresh.completion.dependencies.get(scopeKey(f.leaf.uw))
  if (!dependency?.completion) throw new Error('Managed blocker observation missing')
  const blocker = { number: 42, ...f.state(), dependency: dependency.state, completion: dependency.completion.state }
  const waiting = child(43, { blockedBy: [blocker] })
  expect(dependency.completion.state).toBe('complete')
  expect(openBlockers(waiting, new Map(), 'main')).toEqual([42])
})

it('holds a managed closed blocker with an unknown native close reason', async () => {
  const f = await closeLinkedWorld({ nativeState: { state: 'CLOSED', stateReason: null } })
  const fresh = await f.operations.readUw(f.leaf.uw)
  const dependency = fresh.completion.dependencies.get(scopeKey(f.leaf.uw))
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: null })
  expect(fresh.observation.status).toBe('complete')
  expect(dependency).toMatchObject({ basis: { kind: 'accepted-uw' }, completion: { state: 'complete' }, state: 'held' })
  expect(dependency?.diagnostics.length).toBeGreaterThan(0)
})
