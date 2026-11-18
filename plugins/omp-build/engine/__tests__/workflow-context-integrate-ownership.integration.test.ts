import { expect, it } from 'vitest'
import { cwdInhibition, inhibition } from '../../roxabi/feature-control.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceNativePlan } from '../../testing/native-plan-producer.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { clear } from './workflow-captured-world-fixture.ts'
import { publishCapturedParentIntegration } from './workflow-context-integrate-ownership-fixture.ts'

async function withPreparedParent(
  run: (input: {
    world: Parameters<typeof publishCapturedParentIntegration>[0]
    parent: {
      cwd: string
      checkout(commit: string): void
      tree(commit: string): string
      observe(): { head: string; base: string; branch: string | null; baseTip: string; remoteTip: string }
    }
    third: string
  }) => Promise<void>,
) {
  const checkout = nativeImplementationGit()
  try {
    const [first, second, third] = checkout.merges
    if (!first || !second || !third) throw new Error('Expected three child merges')
    await checkout.publishBase(third)
    const parent = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parent.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, first, second].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(third, checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'framed',
      async (world) => {
        parent.checkout(third)
        await produceNativePlan({
          world: { cwd: parent.cwd, gh: world.gh, git: world.git, operations: world.operations },
          scope: world.parentScope,
          mandate: world.parent,
          parentScopes: [],
          git: { repository: world.parentScope.repository, commit: third, tree: checkout.tree(third) },
          output: {
            steps: [
              {
                id: 'parent-integration',
                criterionIds: ['C1'],
                change: 'Integrate the delivered children',
                doneWhen: 'Save keeps the selected region',
                evidence: 'The parent integration test verifies the criterion',
                paths: ['fixture.txt'],
              },
            ],
            resolutions: [],
          },
          reviews: [clear, clear],
        })
        await run({ world, parent, third })
      },
    )
  } finally {
    checkout.cleanup()
  }
}

it('admits a live-current parent integrate with durable authority and retained commands', async () => {
  await withPreparedParent(async ({ world, parent, third }) => {
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
      admission: { admitted: true, remoteTip: third },
    })
  })
})

it('refuses positive host admission when current is revoked despite durable authority and retains evidence', async () => {
  await withPreparedParent(async ({ world, parent }) => {
    const initial = parent.observe()
    const revoked = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => false,
    })
    expect(cwdInhibition(parent.cwd)).toBeUndefined()
    expect(inhibition(world.parentScope)).toBeUndefined()
    expect(revoked.publication).toMatchObject({ published: true })
    if (revoked.receipt?.kind !== 'action-receipt' || revoked.receipt.payload.phase !== 'result')
      throw new Error('Revoked integrate receipt missing')
    expect(revoked.receipt.payload.structured).toMatchObject({ outcome: 'integrated' })
    expect(revoked.receipt.payload.admission).toMatchObject({
      admitted: false,
      reason: 'integration-local-inhibition',
    })
    expect(revoked.receipt.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
  })
})

it('retains completed-after-stop integrate evidence when current is false without local holds', async () => {
  await withPreparedParent(async ({ world, parent }) => {
    const initial = parent.observe()
    const settled = await publishCapturedParentIntegration(world, parent, {
      initial,
      candidate: initial,
      command: 'bun test parent.test.ts',
      output: 'PASS parent integration',
      current: () => false,
      stop: { kind: 'completed-after-stop', origin: 'host-stop' },
    })
    expect(cwdInhibition(parent.cwd)).toBeUndefined()
    expect(inhibition(world.parentScope)).toBeUndefined()
    expect(settled.publication).toMatchObject({ published: true })
    if (settled.receipt?.kind !== 'action-receipt' || settled.receipt.payload.phase !== 'result')
      throw new Error('Completed-after-stop integrate receipt missing')
    expect(settled.receipt.payload.structured).toMatchObject({ outcome: 'integrated' })
    expect(settled.receipt.payload.admission).toMatchObject({
      admitted: false,
      reason: 'integration-local-inhibition',
    })
  })
})
