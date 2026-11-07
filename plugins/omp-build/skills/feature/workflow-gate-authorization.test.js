import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  policyFromRepository: vi.fn(),
  readAuthorization: vi.fn(),
  withdrawAuthorization: vi.fn(),
}))
vi.mock('./head-authorization.cjs', () => ({ default: api }))

import { disarmReviewedBeforePush } from './landing-foundation.js'
import { enforceArmedGate } from './workflow-gate.js'

const head = 'a'.repeat(40)
const open = { state: 'OPEN', headRefOid: head, labels: [], autoMergeRequest: null }

describe('head authorization lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.policyFromRepository.mockResolvedValue({})
    api.readAuthorization.mockResolvedValue({ allowed: true, receipt: { record: { headSha: head } } })
    api.withdrawAuthorization.mockImplementation(async () => {
      api.readAuthorization.mockResolvedValue({ allowed: false, receipt: { id: 10 } })
      return { id: 10 }
    })
  })

  it('withdraws an authorization even when no reviewed label exists', async () => {
    const gh = vi.fn(async () => JSON.stringify(open))
    await expect(enforceArmedGate('/repo', 7, { gate: open, policy: 'unarmed', gh })).resolves.toMatchObject({
      allowed: false,
      disarmed: true,
    })
    expect(api.withdrawAuthorization).toHaveBeenCalledOnce()
    expect(gh.mock.calls.every(([, args]) => args[0] !== 'pr' || args[1] !== 'edit')).toBe(true)
  })

  it('rejects a later grant observed after withdrawal', async () => {
    api.withdrawAuthorization.mockImplementation(async () => {
      api.readAuthorization.mockResolvedValue({ allowed: true, receipt: { id: 11 } })
      return { id: 10 }
    })
    const gh = vi.fn(async () => JSON.stringify(open))
    await expect(enforceArmedGate('/repo', 7, { gate: open, policy: 'unarmed', gh })).rejects.toThrow(
      'withdrawal barrier changed',
    )
  })

  it('preserves approved native auto when complete policy discovery is unconfigured', async () => {
    api.policyFromRepository.mockResolvedValue(null)
    const gate = { ...open, autoMergeRequest: { pinned: true } }
    const records = { spent: false, verdict: 'Approve (clean)', head }
    await expect(enforceArmedGate('/repo', 7, { gate, records, gh: vi.fn() })).resolves.toEqual({ allowed: true })
    expect(api.readAuthorization).not.toHaveBeenCalled()
  })

  it('does not treat an unreadable policy as absent', async () => {
    api.policyFromRepository.mockRejectedValue(new Error('403'))
    const gh = vi.fn(async () => JSON.stringify(open))
    const push = vi.fn()
    await expect(disarmReviewedBeforePush('/repo', 7, { gh, push })).rejects.toThrow('403')
    expect(push).not.toHaveBeenCalled()
  })

  it('never pushes when withdrawal fails', async () => {
    api.withdrawAuthorization.mockRejectedValue(new Error('403'))
    const gh = vi.fn(async () => JSON.stringify(open))
    const push = vi.fn()
    await expect(disarmReviewedBeforePush('/repo', 7, { gh, push })).rejects.toThrow('403')
    expect(push).not.toHaveBeenCalled()
  })

  it('withdraws a grant when native review no longer approves its head', async () => {
    const gh = vi.fn(async () => JSON.stringify(open))
    const records = { spent: false, verdict: 'Approve (clean)', head: 'b'.repeat(40) }
    await expect(enforceArmedGate('/repo', 7, { gate: open, records, gh })).resolves.toMatchObject({
      allowed: false,
      disarmed: true,
    })
    expect(api.withdrawAuthorization).toHaveBeenCalledOnce()
  })
})
