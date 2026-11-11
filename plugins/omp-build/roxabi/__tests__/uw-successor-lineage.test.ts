import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { selectWorkflowBinding } from '../../dist/contracts.js'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  abandon,
  abandonedLeaf,
  branch,
  fixtureOwnSpec,
  scope,
  selectNew,
  successorControl,
} from './uw-successor-selection-support.ts'

vi.mock('../workflow-checkout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow-checkout.ts')>()),
  runWorktreeBootstrap: async () => ({ ok: true }),
}))
beforeEach(() => {
  vi.stubEnv('OMP_WORKTREE_DIR', '/fixture-worktrees')
})
afterEach(() => {
  vi.unstubAllEnvs()
})
const fixtures = roxabiWorkflowFixtures()
const pull = { repository: 'acme/app', target: 'acme/app#70' }

function historicalChain(control: 'trusted' | 'missing' | 'foreign' | 'conflicting' = 'trusted') {
  return abandonedLeaf((world) => {
    const comments = world.native.comments.get(41)
    if (!comments) throw new Error('Missing historical own UW')
    // Only the valid legacy chain omits M1's abandon; malformed cases keep both own mandates terminal.
    if (control === 'trusted') {
      const oldAbandon = new Set(world.parts(world.abandonment))
      world.native.comments.set(
        41,
        comments.filter((comment) => !oldAbandon.has(comment)),
      )
    }
    const makeSuccessor = (recordId: string) =>
      fixtures.featureMandate(scope, {
        recordId,
        operationId: `operation-${recordId}`,
        ownSpec: fixtureOwnSpec(world.original.payload.ownSpec),
        branch,
        antecedent: { scope, recordId: world.original.recordId, kind: 'mandate' },
      })
    const successor = makeSuccessor('historical-successor')
    world.seed(successor)
    if (control !== 'missing')
      world.seed(successorControl(world.original, successor), control === 'foreign' ? 'outsider' : 'automation')
    if (control === 'conflicting') {
      const competing = makeSuccessor('competing-successor')
      world.seed(competing)
      world.seed(successorControl(world.original, competing, 'conflicting-selection'))
      world.seed(abandon(competing))
    }
    world.seed(abandon(successor))
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, successor, branch, 'main'))
  })
}

test('an abandoned tip with an authenticated revoked predecessor can extend the same PR chain', async () => {
  const subject = await historicalChain()
  const originalFrames = subject.native.comments.get(41)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: { payload: { antecedent: { scope, recordId: 'historical-successor', kind: 'mandate' } } },
  })
  if ('kind' in result || result.mandate === null) throw new Error('Expected historical lineage successor')
  const after = await subject.reader.readUw(scope)
  expect(
    selectWorkflowBinding({
      pullRequest: pull,
      histories: after.histories,
      native: { branch, base: 'main' },
    }),
  ).toMatchObject({
    status: 'bound',
    mandate: { scope, recordId: result.mandate.recordId, kind: 'mandate' },
  })
  expect(
    subject.native.comments
      .get(41)
      ?.slice(0, originalFrames?.length)
      .map((comment) => comment.body),
  ).toEqual(originalFrames)
})

test.each(['missing', 'foreign', 'conflicting'] as const)(
  '%s successor control cannot authorize a replacement of the abandoned tip',
  async (control) => {
    const subject = await historicalChain(control)
    const result = await selectNew(subject)
    expect(result).toMatchObject({ kind: 'blocked' })
    expect(subject.native.writes).toEqual([])
  },
)
