import { expect, test, vi } from 'vitest'
import type { FeatureAuthority } from '../feature-continuation-admission.ts'
import { applyFeatureControl } from '../feature-continuation-controls.ts'
import { featureStopMessage } from '../feature-presentation.ts'
import type { UwOperations } from '../uw-contract.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const mandate = { kind: 'mandate', recordId: 'mandate-1', payload: { role: 'leaf', branch: 'work' } }
const diagnostic = {
  code: 'operator-confirmation-deferred',
  message: 'The operator deferred this decision',
  location: { kind: 'repository' as const, repository: scope.repository },
  related: [],
}

function authority(gh: unknown): FeatureAuthority {
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
    target: null,
    parentHistories: [],
    causal: { histories: [] },
  } as unknown as FeatureAuthority
}

test('deferred abandonment reports its diagnostic without disarming or continuing', async () => {
  const gh = vi.fn(() => {
    throw new Error('No native effect is permitted')
  })
  const abandon = vi.fn(async () => ({ status: 'deferred' as const, diagnostics: [diagnostic] }))
  const result = await applyFeatureControl('abandon', authority(gh), { abandon } as unknown as UwOperations)

  expect(abandon).toHaveBeenCalledOnce()
  expect(abandon).toHaveBeenCalledWith(scope, { scope, recordId: 'mandate-1', kind: 'mandate' })
  expect(result).toEqual({ kind: 'blocked', reason: 'operator-confirmation-deferred', diagnostics: [diagnostic] })
  expect(featureStopMessage(result)).toContain('operator-confirmation-deferred')
  expect(gh).not.toHaveBeenCalled()
})

test('explicit refusal remains distinct from deferral', async () => {
  const gh = vi.fn(() => {
    throw new Error('No native effect is permitted')
  })
  const abandon = vi.fn(async () => ({
    status: 'refused' as const,
    diagnostics: [{ ...diagnostic, code: 'operator-confirmation-declined' }],
  }))
  const result = await applyFeatureControl('abandon', authority(gh), { abandon } as unknown as UwOperations)

  expect(result).toEqual({ kind: 'abandoned', confirmed: false })
  expect(gh).not.toHaveBeenCalled()
})
