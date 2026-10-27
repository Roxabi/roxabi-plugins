import { expect, test } from 'vitest'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from '../../roxabi/review-recovery-gh.ts'
import { preparedReview, recoveryFixture, recoverySmokeCwd } from '../../roxabi/review-recovery-gh-test-support.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { bridgeHarness, root } from '../../testing/review-runtime-support.ts'
import { reviewControllerFor } from '../omp-controller.ts'
import { dispatchPreparedReplacementReview } from '../omp-review-dispatch.ts'

test('activates and announces the exact confirmed replacement inventory', async () => {
  const fixture = recoveryFixture()
  const prepareReview = async () => preparedReview()
  const terminal = await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })
  if (!terminal.ok) throw new Error('terminal fixture setup failed')
  const grant = await ghGrantInterruptedReviewReplacement({
    cwd: recoverySmokeCwd,
    pr: 42,
    contextWindow: 128_000,
    gh: fixture.gh,
    prepareReview,
  })
  if (!grant.ok) throw new Error('grant fixture setup failed')
  const replacement = await ghReplaceInterruptedReview({
    cwd: recoverySmokeCwd,
    pr: 42,
    contextWindow: 128_000,
    gh: fixture.gh,
    prepareReview,
  })
  if (!replacement.ok) throw new Error('replacement fixture setup failed')

  const harness = bridgeHarness()
  const pi = harness.native
  const controller = reviewControllerFor(pi)
  await harness.emitBridge(
    'session_start',
    {},
    {
      ...root,
      cwd: recoverySmokeCwd,
      model: { contextWindow: 128_000 },
      isIdle: () => true,
    },
  )
  await dispatchPreparedReplacementReview(
    pi,
    { cwd: recoverySmokeCwd },
    replacement.value.input,
    replacement.value.inventory,
    replacement.value.grantId,
    { validateReview: async () => ({ ok: true }) },
  )

  expect(harness.messages).toHaveLength(1)
  expect(harness.messages[0]).toContain('OMP_BUILD_NATIVE_BATCH:')
  expect(controller.active()?.operationId).toBe(replacement.value.inventory.operationId)
  expect(harness.messages[0]).toContain('"name":"spec"')

  const mismatchMessages: string[] = []
  const mismatched = {
    ...replacement.value.inventory,
    payload: {
      ...replacement.value.inventory.payload,
      candidateGitSHA: '0'.repeat(40),
    },
  }
  await expect(
    dispatchPreparedReplacementReview(
      createExtensionApiStub({
        sendUserMessage: async (content) => {
          mismatchMessages.push(typeof content === 'string' ? content : '')
        },
      }),
      { cwd: recoverySmokeCwd },
      replacement.value.input,
      mismatched,
      replacement.value.grantId,
      { validateReview: async () => ({ ok: true }) },
    ),
  ).rejects.toThrow('replacement-inventory-template-mismatch')
  expect(mismatchMessages).toEqual([])
})
