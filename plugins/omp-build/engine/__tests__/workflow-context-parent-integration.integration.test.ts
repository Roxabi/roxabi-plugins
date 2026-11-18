import { expect, it } from 'vitest'
import { currentParentIntegration } from '../../roxabi/uw-parent-current-integration.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceNativePlan } from '../../testing/native-plan-producer.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { clear } from './workflow-captured-world-fixture.ts'

it('selects only the admitted parent integration at its published head in the real child delivery graph', async () => {
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
        const initial = parent.observe()
        const produced = await produceParentIntegration(world, parent, {
          initial,
          candidate: initial,
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
        })
        if (produced.receipt.payload.action !== 'integrate' || produced.receipt.payload.phase !== 'result')
          throw new Error('Expected integration result')
        const base = produced.receipt.payload.inputs.manifest.code.base
        const selected = currentParentIntegration(produced.beforeReview, base, third)
        expect(selected.ok && selected.value?.source.record.recordId).toBe(produced.receipt.recordId)
        const stale = currentParentIntegration(produced.beforeReview, base, first)
        expect(stale.ok && stale.value?.source.record.recordId === produced.receipt.recordId).toBe(false)
      },
    )
  } finally {
    checkout.cleanup()
  }
})
