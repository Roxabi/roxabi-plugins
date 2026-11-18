import { expect, it, vi } from 'vitest'
import { implementationEffectAuthority } from '../feature-implementation-authorization.ts'
import { publishAfterRemoteProof } from '../feature-implementation-publication.ts'
import { readFreshUwCausalContext } from '../fix-uw-histories.ts'
import {
  createFinalPublicationProbe,
  finalPublicationBranch,
  finalPublicationTip,
} from './feature-implementation-final-publication-fixture.ts'

vi.mock('../feature-implementation-authorization.ts', () => ({
  implementationEffectAuthority: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('../fix-uw-histories.ts', () => ({
  readFreshUwCausalContext: vi.fn(async () => ({ ok: true, value: { histories: [] } })),
}))

it('revokes original execution during final publisher preparation without an admitted-positive POST', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  expect(probe.live()).toBe(true)
  expect(vi.mocked(implementationEffectAuthority).mock.calls.length).toBeGreaterThan(0)
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({
    published: false,
    retained: true,
    reason: 'implementation-local-inhibition',
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(1)
  expect(probe.retainedDrafts()[0]).toMatchObject({
    kind: 'action-receipt',
    payload: {
      action: 'implement',
      phase: 'result',
      admission: {
        admitted: false,
        published: true,
        commits: [finalPublicationTip],
        paths: ['file.ts'],
        commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
        remoteBranch: finalPublicationBranch,
        remoteTip: finalPublicationTip,
        reason: 'implementation-local-inhibition',
      },
    },
  })
})

it('publishes an admitted-positive result when original execution stays live', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await probe.awaitPublisherPrep()
  expect(probe.live()).toBe(true)
  probe.releasePublisherPrep()
  await expect(pending).resolves.toEqual({ published: true, retained: true })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not mint a second result when a decoded result receipt is already durable', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // First fence already passed; durable history now shows a decoded result receipt.
  // Fence refusal is retention.ts record kind/phase/actionId, not startResolution/incomplete.
  probe.seedDecodedResultReceipt()
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({
    published: false,
    retained: false,
    reason: 'action-result-present',
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not retry retention after a started POST with non-ownership uncertainty', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // POST is allowed; confirmation then fails without the not-started ownership marker.
  probe.forceUncertainAfterPost()
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({
    published: false,
    retained: false,
    reason: 'uncertain',
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
  expect(probe.live()).toBe(false)
})

it('does not retain on ownership-revoked write-started when a requested body was already present', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // Prior requested body already present ⇒ writer ownership-revoked detail is write-started.
  probe.armWriteStartedOwnershipRevoke()
  probe.setLive(false)
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({
    published: false,
    retained: false,
    reason: 'uncertain',
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  })
  expect(probe.admittedPositivePosts()).toBe(0)
  expect(probe.retainedDrafts()).toHaveLength(0)
})

it('does not retain after same-invocation multipart POST then write-started revoke', async () => {
  const probe = createFinalPublicationProbe()
  vi.mocked(implementationEffectAuthority).mockResolvedValue({ ok: true })
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({
    ok: true,
    value: { histories: [probe.binding.history] },
  } as never)

  const pending = publishAfterRemoteProof(
    probe.binding,
    probe.input,
    probe.claims,
    probe.commits,
    probe.admission,
    probe.child,
    probe.confirmedRemote,
  )
  await Promise.race([
    probe.awaitPublisherPrep(),
    pending.then((published) => {
      throw new Error(`settled before publisher preparation: ${JSON.stringify(published)}`)
    }),
  ])
  // First body POSTs and flips live; second body hits real writer gate → write-started.
  probe.armMultipartPostThenRevoke()
  probe.releasePublisherPrep()
  const published = await pending

  expect(published).toMatchObject({
    published: false,
    retained: false,
    reason: 'uncertain',
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  })
  expect(probe.admittedPositivePosts()).toBe(1)
  expect(probe.retainedDrafts()).toHaveLength(0)
  expect(probe.live()).toBe(false)
})
