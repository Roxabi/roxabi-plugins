import { expect, it, vi } from 'vitest'
import { resolvePublication } from '../feature-action-publication-context.ts'
import { admitIntegration } from '../feature-integration-admission.ts'
import { publishIntegrationResult } from '../feature-integration-result.ts'
import {
  createIntegrationFinalPublicationProbe,
  integrationPublicationTip,
} from './feature-integration-final-publication-fixture.ts'

vi.mock('../feature-action-publication-context.ts', () => ({ resolvePublication: vi.fn() }))
vi.mock('../feature-integration-admission.ts', () => ({ admitIntegration: vi.fn() }))
vi.mock('../../dist/contracts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../dist/contracts.js')>()
  return {
    ...actual,
    integrationOutputSchema: {
      safeParse: (value: unknown) => ({ success: true as const, data: value }),
    },
  }
})

it('revokes original execution during final publisher preparation without an admitted-positive POST', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  vi.mocked(resolvePublication).mockResolvedValue(probe.context as never)
  vi.mocked(admitIntegration).mockResolvedValue(probe.admission)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.context.gh,
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
  vi.mocked(resolvePublication).mockResolvedValue(probe.context as never)
  vi.mocked(admitIntegration).mockResolvedValue(probe.admission)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.context.gh,
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

it('does not retry retention after the first of multiple bodies posts then ownership is write-started', async () => {
  const probe = createIntegrationFinalPublicationProbe()
  vi.mocked(resolvePublication).mockResolvedValue(probe.context as never)
  vi.mocked(admitIntegration).mockResolvedValue(probe.admission)

  const pending = publishIntegrationResult({
    cwd: '/checkout',
    start: probe.start,
    result: probe.result,
    gh: probe.context.gh,
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    current: probe.current,
  })
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // Two missing bodies: first POST succeeds, then live ownership drops before the second.
  // Writer returns ownership-revoked detail=write-started; publicationDidNotStart is false.
  probe.armPartialAfterFirstBody()
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({ published: false, reason: 'uncertain' })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
  expect(probe.live()).toBe(false)
})
