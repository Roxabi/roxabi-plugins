import { expect, it, vi } from 'vitest'
import { loadContracts } from '../feature-engine.ts'
import { admitIntegration } from '../feature-integration-admission.ts'
import { publishIntegrationResult } from '../feature-integration-result.ts'
import { readFreshUwCausalContext } from '../fix-uw-histories.ts'
import {
  createIntegrationFinalPublicationProbe,
  integrationPublicationTip,
} from './feature-integration-final-publication-fixture.ts'
import { fixtureCausalContext } from './feature-integration-final-publication-history-fixture.ts'

vi.mock('../feature-integration-admission.ts', () => ({ admitIntegration: vi.fn() }))
vi.mock('../feature-engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../feature-engine.ts')>()
  return { ...actual, loadContracts: vi.fn(actual.loadContracts) }
})
vi.mock('../fix-uw-histories.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fix-uw-histories.ts')>()
  return { ...actual, readFreshUwCausalContext: vi.fn(actual.readFreshUwCausalContext) }
})
vi.mock('../../dist/contracts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dist/contracts.js')>()
  return {
    ...actual,
    integrationOutputSchema: {
      safeParse: (value: unknown) => ({ success: true as const, data: value }),
    },
  }
})

function armProbe(probe: ReturnType<typeof createIntegrationFinalPublicationProbe>) {
  // Controlled seams: loadContracts + typed causal context + admission.
  // Late retention fence still runs production resolvePublication → real startResolution.
  vi.mocked(loadContracts).mockResolvedValue(probe.loaded)
  vi.mocked(readFreshUwCausalContext).mockImplementation(async (_scope, histories) => ({
    ok: true as const,
    value: fixtureCausalContext(histories),
  }))
  vi.mocked(admitIntegration).mockResolvedValue(probe.admission)
}

it('revokes original execution during final publisher preparation without an admitted-positive POST', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  armProbe(probe)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  expect(probe.live()).toBe(true)
  expect(vi.mocked(admitIntegration).mock.calls.length).toBeGreaterThan(0)
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({ published: true })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(1)
  expect(probe.retainedDrafts()[0]).toMatchObject({
    kind: 'action-receipt',
    payload: {
      action: 'integrate',
      phase: 'result',
      structured: probe.structured,
      admission: {
        admitted: false,
        published: true,
        commits: [integrationPublicationTip],
        paths: ['fixture.txt'],
        commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
        remoteBranch: null,
        remoteTip: integrationPublicationTip,
        reason: 'integration-local-inhibition',
      },
    },
  })
})

it('publishes an admitted-positive integrate when original execution stays live', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  armProbe(probe)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await probe.awaitPublisherPrep()
  expect(probe.live()).toBe(true)
  probe.releasePublisherPrep()
  await expect(pending).resolves.toMatchObject({ published: true })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not mint a retained result when a competing authenticated RESULT already terminalizes START', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  armProbe(probe)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // Competing RESULT shares action/START/mandate/inputs; different record + operation identity.
  // Production resolvePublication retention re-fence must refuse via action-result-present.
  probe.seedCompetingResultReceipt()
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({ published: false, reason: 'action-result-present' })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not mint a retained result when interruption resolution becomes invalid during positive preparation', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  armProbe(probe)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // Partial unrelated interruption-resolution invalidates production resolutionIndex.
  probe.armInvalidInterruptionResolution()
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({ published: false, reason: 'interruption-resolution-invalid' })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not retry retention after the first of multiple bodies posts then ownership is write-started', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  armProbe(probe)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  probe.armPartialAfterFirstBody()
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({ published: false, reason: 'uncertain' })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
  expect(probe.live()).toBe(false)
})
