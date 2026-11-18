import { afterEach, expect, test, vi } from 'vitest'
import type { FeatureAuthority } from '../feature-continuation-admission.ts'
import { applyFeatureControl } from '../feature-continuation-controls.ts'
import {
  cwdInhibition,
  type FeatureControlInhibition,
  inhibit,
  inhibitCwd,
  inhibition,
  releaseAbandonInhibition,
  releaseCwdInhibition,
  releaseInhibition,
} from '../feature-control.ts'
import type { UwOperations } from '../uw-contract.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const otherScope = { repository: 'acme/app', target: 'acme/app#99' }
const foreignScope = { repository: 'acme/other', target: 'acme/other#7' }
const mandate = { kind: 'mandate', recordId: 'mandate-1', payload: { role: 'leaf', branch: 'work' } }
const issueTarget = {
  status: 'issue' as const,
  scope,
  issue: { repository: 'acme/app', number: 42, state: 'OPEN', author: 'automation', body: '', isPullRequest: false },
}

afterEach(() => {
  releaseInhibition(scope)
  releaseInhibition(otherScope)
  releaseInhibition(foreignScope)
  releaseCwdInhibition('/work')
  releaseCwdInhibition('/other')
})

function authority(gh: unknown, controlInhibition?: FeatureControlInhibition): FeatureAuthority {
  return {
    context: {
      cwd: '/work',
      gh,
      engine: {
        resolveAcceptedSpec: () => ({ ok: true, spec: {} }),
        effectiveMandateRole: () => 'leaf',
      },
    },
    history: { source: { scope } },
    scope,
    selection: { status: 'applicable', mandate },
    target: issueTarget,
    parentHistories: [],
    causal: { histories: [] },
    ...(controlInhibition === undefined ? {} : { controlInhibition }),
  } as unknown as FeatureAuthority
}

test('releaseAbandonInhibition deletes only the identical abandon entry', () => {
  const first = inhibit(scope, 'abandon')
  const second = inhibit(scope, 'abandon')
  expect(first).not.toBe(second)
  releaseAbandonInhibition(scope, first)
  expect(inhibition(scope)).toBe('abandon')
  releaseAbandonInhibition(scope, second)
  expect(inhibition(scope)).toBeUndefined()
})

test('releaseAbandonInhibition is a no-op for missing, pause, or stale tokens', () => {
  const live = inhibit(scope, 'abandon')
  releaseAbandonInhibition(scope, undefined)
  expect(inhibition(scope)).toBe('abandon')
  const pauseToken = inhibit(scope, 'pause')
  releaseAbandonInhibition(scope, pauseToken)
  expect(inhibition(scope)).toBe('pause')
  inhibit(scope, 'abandon')
  releaseAbandonInhibition(scope, live)
  expect(inhibition(scope)).toBe('abandon')
})

test('successful release preserves unrelated scope and cwd holds', async () => {
  const captured = inhibit(scope, 'abandon')
  inhibit(otherScope, 'pause')
  inhibit(foreignScope, 'abandon')
  inhibitCwd('/work')
  inhibitCwd('/other')
  const gh = vi.fn(async () => '[]')
  const abandon = vi.fn(async () => ({ status: 'abandoned' as const, uw: scope }))
  const result = await applyFeatureControl('abandon', authority(gh, captured), {
    abandon,
  } as unknown as UwOperations)
  expect(result).toEqual({ kind: 'abandoned', confirmed: true })
  expect(inhibition(scope)).toBeUndefined()
  expect(inhibition(otherScope)).toBe('pause')
  expect(inhibition(foreignScope)).toBe('abandon')
  expect(cwdInhibition('/work')).toBe('pause')
  expect(cwdInhibition('/other')).toBe('pause')
})

test.each(['pause', 'abandon'] as const)(
  'finishing abandon after a newer %s replacement during uw.abandon preserves the replacement',
  async (replacement) => {
    const captured = inhibit(scope, 'abandon')
    const { promise, resolve } = Promise.withResolvers<{ status: 'abandoned'; uw: typeof scope }>()
    const abandon = vi.fn(() => promise)
    const gh = vi.fn(async () => '[]')
    const pending = applyFeatureControl('abandon', authority(gh, captured), {
      abandon,
    } as unknown as UwOperations)
    await Promise.resolve()
    expect(abandon).toHaveBeenCalledOnce()
    inhibit(scope, replacement)
    resolve({ status: 'abandoned', uw: scope })
    await expect(pending).resolves.toEqual({ kind: 'abandoned', confirmed: true })
    expect(inhibition(scope)).toBe(replacement)
  },
)

test('finishing abandon after abandon→pause→abandon ABA during uw.abandon preserves later abandon', async () => {
  const captured = inhibit(scope, 'abandon')
  const { promise, resolve } = Promise.withResolvers<{ status: 'abandoned'; uw: typeof scope }>()
  const abandon = vi.fn(() => promise)
  const gh = vi.fn(async () => '[]')
  const pending = applyFeatureControl('abandon', authority(gh, captured), {
    abandon,
  } as unknown as UwOperations)
  await Promise.resolve()
  inhibit(scope, 'pause')
  const laterAbandon = inhibit(scope, 'abandon')
  resolve({ status: 'abandoned', uw: scope })
  await expect(pending).resolves.toEqual({ kind: 'abandoned', confirmed: true })
  expect(inhibition(scope)).toBe('abandon')
  releaseAbandonInhibition(scope, laterAbandon)
  expect(inhibition(scope)).toBeUndefined()
})

test.each(['pause', 'abandon'] as const)(
  'disarm-gated newer %s replacement survives confirmed abandonment',
  async (replacement) => {
    const captured = inhibit(scope, 'abandon')
    const abandon = vi.fn(async () => ({ status: 'abandoned' as const, uw: scope }))
    const { promise, resolve } = Promise.withResolvers<string>()
    const gh = vi.fn(() => promise)
    const pending = applyFeatureControl('abandon', authority(gh, captured), {
      abandon,
    } as unknown as UwOperations)
    await Promise.resolve()
    await Promise.resolve()
    expect(abandon).toHaveBeenCalledOnce()
    expect(gh).toHaveBeenCalled()
    inhibit(scope, replacement)
    resolve('[]')
    await expect(pending).resolves.toEqual({ kind: 'abandoned', confirmed: true })
    expect(inhibition(scope)).toBe(replacement)
  },
)

test('thrown UW abandon preserves the captured hold', async () => {
  const captured = inhibit(scope, 'abandon')
  const gh = vi.fn()
  const abandon = vi.fn(async () => {
    throw new Error('operator channel collapsed')
  })
  await expect(
    applyFeatureControl('abandon', authority(gh, captured), { abandon } as unknown as UwOperations),
  ).rejects.toThrow('operator channel collapsed')
  expect(inhibition(scope)).toBe('abandon')
  expect(gh).not.toHaveBeenCalled()
})
