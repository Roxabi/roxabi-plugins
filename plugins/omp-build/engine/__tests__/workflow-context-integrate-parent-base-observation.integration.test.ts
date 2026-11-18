import { expect, it } from 'vitest'
import { cwdInhibition, inhibition } from '../../roxabi/feature-control.ts'
import { publishCapturedParentIntegration } from './workflow-context-integrate-ownership-fixture.ts'
import {
  armRevokeAfterMatchingPublishedBaseObservation,
  withPreparedParentIntegration,
} from './workflow-context-integrate-parent-base-observation-fixture.ts'

it('admits a live-current parent integrate retaining the observed published base tip', async () => {
  await withPreparedParentIntegration(async ({ world, parent, third }) => {
    const initial = parent.observe()
    const live = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => true,
    })
    expect(live.publication).toMatchObject({ published: true })
    if (live.receipt?.kind !== 'action-receipt' || live.receipt.payload.phase !== 'result')
      throw new Error('Live integrate receipt missing')
    expect(live.receipt.payload).toMatchObject({
      structured: { outcome: 'integrated' },
      admission: { admitted: true, published: true, remoteTip: third },
    })
  })
})

it('keeps remoteTip null when ownership is already false before published-base observation', async () => {
  await withPreparedParentIntegration(async ({ world, parent }) => {
    const initial = parent.observe()
    const refused = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => false,
    })
    expect(cwdInhibition(parent.cwd)).toBeUndefined()
    expect(inhibition(world.parentScope)).toBeUndefined()
    expect(refused.publication).toMatchObject({ published: true })
    if (refused.receipt?.kind !== 'action-receipt' || refused.receipt.payload.phase !== 'result')
      throw new Error('Pre-observation refuse receipt missing')
    expect(refused.receipt.payload.admission).toMatchObject({
      admitted: false,
      published: false,
      remoteTip: null,
      reason: 'integration-local-inhibition',
    })
  })
})

it('retains the observed published base tip when ownership dies after matching observations', async () => {
  await withPreparedParentIntegration(async ({ world, parent, third }) => {
    const initial = parent.observe()
    const ownership = { live: true }
    const retained = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => ownership.live,
      beforePublication: ({ world: publicationWorld, candidateHead }) => {
        armRevokeAfterMatchingPublishedBaseObservation(publicationWorld, ownership, candidateHead)
      },
    })
    expect(ownership.live).toBe(false)
    expect(cwdInhibition(parent.cwd)).toBeUndefined()
    expect(inhibition(world.parentScope)).toBeUndefined()
    expect(retained.publication).toMatchObject({ published: true })
    if (retained.receipt?.kind !== 'action-receipt' || retained.receipt.payload.phase !== 'result')
      throw new Error('Retained base-observation receipt missing')
    // Matching base observation is factual published evidence; admitted stays false (not freshness).
    expect(retained.receipt.payload.structured).toMatchObject({ outcome: 'integrated' })
    expect(retained.receipt.payload.admission).toMatchObject({
      admitted: false,
      published: true,
      remoteTip: third,
      reason: 'integration-local-inhibition',
    })
    expect(retained.receipt.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
  })
})

it('retains the observed published base tip when final authority dies after successful base proof', async () => {
  await withPreparedParentIntegration(async ({ world, parent, third }) => {
    const initial = parent.observe()
    const ownership = { live: true }
    const retained = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => ownership.live,
      beforePublication: ({ world: publicationWorld, candidateHead }) => {
        // Second matching ls-remote is the post-authority reread; revoke before finalAuthority.
        armRevokeAfterMatchingPublishedBaseObservation(publicationWorld, ownership, candidateHead, 'main', 2)
      },
    })
    expect(ownership.live).toBe(false)
    expect(cwdInhibition(parent.cwd)).toBeUndefined()
    expect(inhibition(world.parentScope)).toBeUndefined()
    expect(retained.publication).toMatchObject({ published: true })
    if (retained.receipt?.kind !== 'action-receipt' || retained.receipt.payload.phase !== 'result')
      throw new Error('Final-authority retained-base receipt missing')
    expect(retained.receipt.payload.structured).toMatchObject({ outcome: 'integrated' })
    expect(retained.receipt.payload.admission).toMatchObject({
      admitted: false,
      published: true,
      remoteTip: third,
      reason: 'integration-local-inhibition',
    })
    expect(retained.receipt.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
  })
})
