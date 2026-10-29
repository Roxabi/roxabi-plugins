import { afterEach, expect, test } from 'vitest'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from '../../roxabi/review-recovery-gh.ts'
import { preparedReview, recoveryFixture, recoverySmokeCwd } from '../../roxabi/review-recovery-gh-test-support.ts'
import type { UwOperations } from '../../roxabi/uw-contract.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { reviewControllerFor } from '../omp-controller.ts'
import { dispatchPreparedReplacementReview } from '../omp-review-dispatch.ts'

const root = consultableAgentRoot()

afterEach(() => {
  cleanupFixtureActions()
})

const operations = {
  readUw: async () => {
    throw new Error('unexpected-operations')
  },
  prepare: async () => {
    throw new Error('unexpected-operations')
  },
  validateNormalization: () => {
    throw new Error('unexpected-operations')
  },
  write: async () => {
    throw new Error('unexpected-operations')
  },
  create: async () => {
    throw new Error('unexpected-operations')
  },
  acceptMaterial: async () => {
    throw new Error('unexpected-operations')
  },
  prepareAction: async () => {
    throw new Error('unexpected-operations')
  },
  prepareReviewActions: async () => {
    throw new Error('unexpected-operations')
  },
  replayActionInputs: async () => {
    throw new Error('unexpected-operations')
  },
  verifyAction: async () => {
    throw new Error('unexpected-operations')
  },
  readDelivery: async () => {
    throw new Error('unexpected-operations')
  },
} satisfies UwOperations

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
    operations,
    prepareReview,
  })
  if (!grant.ok) throw new Error('grant fixture setup failed')
  const replacement = await ghReplaceInterruptedReview({
    cwd: recoverySmokeCwd,
    pr: 42,
    contextWindow: 128_000,
    gh: fixture.gh,
    operations,
    prepareReview,
  })
  if (!replacement.ok) throw new Error('replacement fixture setup failed')
  for (const slot of replacement.value.inventory.payload.slots) {
    const action = replacement.value.input.actions[slot.slotId]
    if (action === undefined) throw new Error(`replacement action missing: ${slot.slotId}`)
    expect(slot.action).toEqual({ actionId: action.snapshot.actionId, inputs: action.inputs })
  }

  const harness = bridgeHarness()
  const pi = harness.native
  const controller = reviewControllerFor(pi)
  const model = { id: 'fixture-model', provider: 'fixture-provider', contextWindow: 128_000 }
  await harness.emitBridge(
    'session_start',
    {},
    {
      ...root,
      cwd: recoverySmokeCwd,
      sessionManager: { getSessionId: () => 'replacement-review-session' },
      model,
      models: { resolve: () => model, current: () => model },
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

  const batchMessage = harness.messages.find((message) => message.includes('OMP_BUILD_NATIVE_BATCH:'))
  expect(batchMessage).toContain('OMP_BUILD_NATIVE_BATCH:')
  expect(controller.active()?.operationId).toBe(replacement.value.inventory.operationId)
  expect(batchMessage).toContain('"name":"spec"')

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
  const mismatchedAction = {
    ...replacement.value.inventory,
    payload: {
      ...replacement.value.inventory.payload,
      slots: replacement.value.inventory.payload.slots.map((slot, index) =>
        index === 0 && slot.action !== undefined
          ? { ...slot, action: { ...slot.action, actionId: 'wrong-action' } }
          : slot,
      ),
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
      mismatchedAction,
      replacement.value.grantId,
      { validateReview: async () => ({ ok: true }) },
    ),
  ).rejects.toThrow('replacement-inventory-template-mismatch')
  if (!('inputSnapshot' in replacement.value.inventory.payload)) throw new Error('replacement snapshot missing')
  const mismatchedSnapshot = {
    ...replacement.value.inventory,
    payload: {
      ...replacement.value.inventory.payload,
      inputSnapshot: { ...replacement.value.inventory.payload.inputSnapshot, fingerprint: '0'.repeat(64) },
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
      mismatchedSnapshot,
      replacement.value.grantId,
      { validateReview: async () => ({ ok: true }) },
    ),
  ).rejects.toThrow('replacement-inventory-template-mismatch')
  expect(mismatchMessages).toEqual([])
})
