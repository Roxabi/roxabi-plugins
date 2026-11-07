import { expect, it } from 'vitest'
import { scopeKey } from '../../engine/uw-graph.ts'
import { closeLinkedWorld } from './uw-close-linked-fixture.ts'

it('does not infer delivery from manual closure or a confirmed reopen', async () => {
  const world = await closeLinkedWorld({
    nativeState: { state: 'CLOSED', stateReason: 'COMPLETED' },
    confirmReopen: true,
  })
  try {
    // Remove the authenticated final review; native closure alone is not delivery proof.
    world.removeReview()
    const before = await world.operations.readUw(world.leaf.uw)
    expect(before.observation.status).toBe('complete')
    expect(before.accepted.status).toBe('accepted')
    expect(before.graph.nodes.find((node) => node.uw.target === world.leaf.uw.target)?.native).toEqual({
      state: 'CLOSED',
      stateReason: 'COMPLETED',
    })
    const beforeCompletion = before.completion.completions.get(scopeKey(world.leaf.uw))
    expect(beforeCompletion).toBeDefined()
    expect(beforeCompletion?.state).not.toBe('complete')
    expect(beforeCompletion).toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'native-closure-unproven' })]),
    })
    expect(world.confirmations()).toBe(0)
    expect(world.effects).toEqual([])

    const reopened = await world.operations.reopen(world.leaf.uw)
    expect(reopened, JSON.stringify(reopened)).toMatchObject({ status: 'written' })
    expect(world.confirmations()).toBe(1)
    expect(world.effects).toEqual(['reopen'])
    const after = await world.operations.readUw(world.leaf.uw)
    expect(after.observation.status).toBe('complete')
    expect(after.accepted.status).toBe('accepted')
    expect(after.graph.nodes.find((node) => node.uw.target === world.leaf.uw.target)?.native).toEqual({
      state: 'OPEN',
      stateReason: 'REOPENED',
    })
    const afterCompletion = after.completion.completions.get(scopeKey(world.leaf.uw))
    expect(afterCompletion).toBeDefined()
    expect(afterCompletion?.state).not.toBe('complete')
    expect(afterCompletion).not.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'native-closure-unproven' })]),
    })
  } finally {
    world.dispose()
  }
})
