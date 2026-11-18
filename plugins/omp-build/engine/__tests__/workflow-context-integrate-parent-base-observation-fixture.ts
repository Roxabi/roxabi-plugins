import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceNativePlan } from '../../testing/native-plan-producer.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { clear } from './workflow-captured-world-fixture.ts'
import type { publishCapturedParentIntegration } from './workflow-context-integrate-ownership-fixture.ts'

export type PreparedParentIntegration = {
  world: Parameters<typeof publishCapturedParentIntegration>[0]
  parent: {
    cwd: string
    checkout(commit: string): void
    tree(commit: string): string
    observe(): { head: string; base: string; branch: string | null; baseTip: string; remoteTip: string }
  }
  third: string
}

/** Prepare a framed parent integrate world with three delivered children. */
export async function withPreparedParentIntegration(run: (input: PreparedParentIntegration) => Promise<void>) {
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

/**
 * After `afterMatches` matching published-base `ls-remote` results, revoke original
 * execution `current`. Default 1 = before second authority; 2 = after final reread,
 * before admitIntegration's final authority. Observed tip remains factual, not fresh.
 */
export function armRevokeAfterMatchingPublishedBaseObservation(
  world: { git: GitRunner },
  ownership: { live: boolean },
  tip: string,
  base = 'main',
  afterMatches = 1,
) {
  let matches = 0
  const prior = world.git
  world.git = async (cwd, args) => {
    const result = await prior(cwd, args)
    if (
      ownership.live &&
      args[0] === 'ls-remote' &&
      args[1] === 'origin' &&
      args[2] === `refs/heads/${base}` &&
      result.code === 0 &&
      (result.stdout.trim().split(/\s+/)[0] ?? '') === tip
    ) {
      matches += 1
      if (matches >= afterMatches) {
        void Promise.resolve().then(() => {
          ownership.live = false
        })
      }
    }
    return result
  }
}
