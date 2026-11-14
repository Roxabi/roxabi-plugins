import { describe, expect, it, vi } from 'vitest'
import type { ScopedRecordRef } from '../../engine/record-references.ts'
import type { ContinueFeatureInput } from '../feature-contract.ts'
import {
  claimStartActivation,
  recordStartActivationFailed,
  recordStartClosedBeforeAdmission,
  recordStartNotActivated,
  startDispatch,
} from '../feature-start-executions.ts'
import { continueFeature } from '../workflow.ts'

const continuation = vi.hoisted(() => ({
  authority: vi.fn(),
  observation: vi.fn(),
  select: vi.fn(),
  reconstruct: vi.fn(),
  action: vi.fn(),
  ciStop: vi.fn(),
  readUw: vi.fn(),
}))
vi.mock('../feature-continuation-admission.ts', () => ({ resolveFeatureAuthority: continuation.authority }))
vi.mock('../feature-continuation-selection.ts', () => ({ selectFeatureMandate: continuation.select }))
vi.mock('../feature-continuation-observation.ts', () => ({ readFeatureObservation: continuation.observation }))
vi.mock('../workflow-plan-receipt.ts', () => ({ coordinatePlanAndReceiptAction: continuation.action }))
vi.mock('../../skills/feature/workflow-review-state.js', async (original) => ({
  ...((await original()) as object),
  persistObservedCiStop: continuation.ciStop,
}))
vi.mock('../uw-read-port.ts', () => ({
  createInstalledObservedUwReadPort: () => ({ readUw: continuation.readUw }),
}))

const start = (recordId: string): ScopedRecordRef => ({
  scope: { repository: 'acme/app', target: 'acme/app#42' },
  kind: 'action-receipt',
  recordId,
})
describe('START dispatch facts', () => {
  it('retains unknown separately from a claimed activation', () => {
    const ref = start('claimed-start')
    expect(startDispatch(ref)).toBeUndefined()
    expect(claimStartActivation(ref, 'op-1')).toBe(true)
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: 'op-1' })
    recordStartNotActivated(ref)
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: 'op-1' })
  })

  it('denies a claim after a refused activation or a fenced closure', () => {
    const refused = start('refused-start')
    recordStartNotActivated(refused)
    const refusedSnapshot = startDispatch(refused)
    expect(claimStartActivation(refused, 'op-2')).toBe(false)
    expect(refusedSnapshot).toEqual({ kind: 'not-activated' })
    expect(startDispatch(refused)).toEqual({ kind: 'conflict' })

    const closed = start('closed-start')
    expect(claimStartActivation(closed, 'op-3')).toBe(true)
    recordStartClosedBeforeAdmission(closed, 'op-3')
    recordStartClosedBeforeAdmission(closed, 'op-3')
    expect(startDispatch(closed)).toEqual({ kind: 'closed-before-admission', operationId: 'op-3' })
    expect(claimStartActivation(closed, 'op-3')).toBe(false)
    expect(startDispatch(closed)).toEqual({ kind: 'conflict' })
  })

  it('cannot close or undo an activation belonging to a different operation', () => {
    const closed = start('wrong-close-start')
    expect(claimStartActivation(closed, 'op-4')).toBe(true)
    recordStartClosedBeforeAdmission(closed, 'op-5')
    expect(startDispatch(closed)).toEqual({ kind: 'conflict' })
    const failed = start('wrong-failed-start')
    expect(claimStartActivation(failed, 'op-6')).toBe(true)
    recordStartActivationFailed(failed, 'op-7')
    expect(startDispatch(failed)).toEqual({ kind: 'conflict' })
  })

  it('records an atomic activation throw as not activated', () => {
    const ref = start('activation-throw-start')
    expect(claimStartActivation(ref, 'op-8')).toBe(true)
    recordStartActivationFailed(ref, 'op-8')
    expect(startDispatch(ref)).toEqual({ kind: 'not-activated' })
  })
})

describe('continuation owner revocation before engine dispatch', () => {
  it.each([
    ['land', { status: 'action', action: 'land' }],
    ['START', { status: 'action', action: 'plan' }],
    ['CI stop', { status: 'terminal', reason: 'bound-stop', evidence: [] }],
    ['close', { status: 'terminal', reason: 'done', evidence: [] }],
  ])('does not dispatch %s when the owner changes during observation', async (_label, decision) => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let owned = true
    const authority = {
      context: { cwd: '/workspace', engine: { reconstructWorkflow: continuation.reconstruct } },
      scope: { repository: 'acme/app', target: 'acme/app#42' },
    }
    continuation.authority.mockResolvedValue(authority)
    continuation.select.mockResolvedValue({
      authority,
      mandate: null,
      acceptedSpec: null,
      mandateRef: { ...start('mandate'), kind: 'mandate' },
    })
    continuation.reconstruct.mockReset().mockReturnValue(decision)
    continuation.action.mockReset().mockResolvedValue({ kind: 'terminal', reason: 'action-dispatched' })
    continuation.ciStop.mockReset().mockResolvedValue(true)
    continuation.readUw.mockReset().mockResolvedValue({
      completion: { completions: new Map([['acme/app\0acme/app#42', { state: 'complete' }]]) },
    })
    continuation.observation.mockImplementation(async () => {
      entered.resolve()
      await gate.promise
      return {
        evidence: { causal: { observation: {} } },
        facts: {},
        decisions: { ciWatchStatus: 'red', reviewStep: 'stop' },
        delivery: { number: 7, head: 'head', scope: { repository: 'acme/app', target: 'acme/app#7' } },
        deliveryAdmission: { admission: { deliverable: { diagnostics: [] } } },
        reviewId: 'review-1',
      }
    })
    const closeLinked = vi.fn().mockResolvedValue({ status: 'written' })
    const input = {
      cwd: '/workspace',
      reference: '42',
      control: 'continue',
      principal: false,
      owned: () => owned,
      uw: { closeLinked },
    } as unknown as ContinueFeatureInput
    const pending = continueFeature(input)
    await entered.promise
    owned = false
    gate.resolve()
    expect(await pending).toEqual({ kind: 'blocked', reason: 'continuation-owner-revoked' })
    expect(continuation.reconstruct).toHaveBeenCalledOnce()
    expect(continuation.action).not.toHaveBeenCalled()
    expect(continuation.ciStop).not.toHaveBeenCalled()
    expect(continuation.readUw).not.toHaveBeenCalled()
    expect(closeLinked).not.toHaveBeenCalled()
  })

  it('does not select or publish a mandate when owner changes during authority resolution', async () => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let owned = true
    const authority = {
      context: { cwd: '/workspace', engine: { reconstructWorkflow: continuation.reconstruct } },
      scope: { repository: 'acme/app', target: 'acme/app#42' },
    }
    continuation.select.mockReset().mockResolvedValue({ authority, mandate: null, acceptedSpec: null })
    continuation.observation.mockReset().mockResolvedValue({ evidence: {}, facts: {}, decisions: {} })
    continuation.reconstruct.mockReset().mockReturnValue({ status: 'blocked', reason: 'fixture-stop', evidence: [] })
    continuation.authority.mockImplementation(async () => {
      entered.resolve()
      await gate.promise
      return authority
    })
    const input = {
      cwd: '/workspace',
      reference: '42',
      control: 'continue',
      principal: false,
      owned: () => owned,
    } as ContinueFeatureInput
    const pending = continueFeature(input)
    await entered.promise
    owned = false
    gate.resolve()
    expect(await pending).toEqual({ kind: 'blocked', reason: 'continuation-owner-revoked' })
    expect(continuation.select).not.toHaveBeenCalled()
  })

  it('dispatches an action while the owner remains current', async () => {
    const authority = {
      context: { cwd: '/workspace', engine: { reconstructWorkflow: continuation.reconstruct } },
      scope: { repository: 'acme/app', target: 'acme/app#42' },
    }
    continuation.authority.mockResolvedValue(authority)
    continuation.select.mockResolvedValue({ authority, mandate: null, acceptedSpec: null })
    continuation.observation.mockResolvedValue({
      evidence: {},
      facts: {},
      decisions: {},
      deliveryAdmission: { admission: { deliverable: { diagnostics: [] } } },
    })
    continuation.reconstruct.mockReset().mockReturnValue({ status: 'action', action: 'plan' })
    continuation.action.mockReset().mockResolvedValue({ kind: 'terminal', reason: 'action-dispatched' })
    const result = await continueFeature({
      cwd: '/workspace',
      reference: '42',
      control: 'continue',
      principal: false,
      owned: () => true,
    })
    expect(result).toEqual({ kind: 'terminal', reason: 'action-dispatched' })
    expect(continuation.action).toHaveBeenCalledOnce()
  })
})
