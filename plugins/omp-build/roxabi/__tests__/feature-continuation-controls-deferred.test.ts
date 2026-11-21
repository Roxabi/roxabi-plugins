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

  expect(result).toMatchObject({ kind: 'abandoned', confirmed: false, failure: { phase: 'uw', status: 'refused' } })
  expect(featureStopMessage(result)).toContain('operator-confirmation-declined')
  expect(gh).not.toHaveBeenCalled()
})

test('preserves raw UW diagnostics while sanitizing their operator projection', async () => {
  const gh = vi.fn()
  const failure = {
    ...diagnostic,
    code: 'refused GH_TOKEN=code-fake',
    message:
      'Native refusal GITHUB_TOKEN=github-fake access_token=access-fake Authorization: Basic basic-fake \u009b\u202e',
  }
  const abandon = vi.fn(async () => ({ status: 'refused' as const, diagnostics: [failure] }))
  const result = await applyFeatureControl('abandon', authority(gh), { abandon } as unknown as UwOperations)

  expect(result).toMatchObject({ failure: { phase: 'uw', status: 'refused', diagnostics: [failure] } })
  const message = featureStopMessage(result)
  expect(message).toContain('Native refusal')
  expect(message).toContain('\\u202e')
  for (const secret of ['code-fake', 'github-fake', 'access-fake', 'basic-fake']) {
    expect(message).not.toContain(secret)
  }
  expect(message).not.toContain('\u009b')
  expect(message).not.toContain('\u202e')
  expect(gh).not.toHaveBeenCalled()
})

test.each(['partial', 'uncertain'] as const)('shows %s abandonment evidence without disarming', async (status) => {
  const gh = vi.fn()
  const failure = { ...diagnostic, code: 'abandon-readback-unconfirmed', message: 'Record readback failed' }
  const abandon = vi.fn(async () => ({ status, uw: scope, diagnostics: [failure] }))
  const result = await applyFeatureControl('abandon', authority(gh), { abandon } as unknown as UwOperations)

  expect(result).toMatchObject({ kind: 'abandoned', confirmed: false, failure: { phase: 'uw', status } })
  expect(featureStopMessage(result)).toContain(status)
  expect(featureStopMessage(result)).toContain('abandon-readback-unconfirmed: Record readback failed')
  expect(gh).not.toHaveBeenCalled()
})

test('reports failed disarm discovery after publication without claiming confirmed abandonment', async () => {
  const gh = vi.fn(async () => {
    throw new Error('linked PR discovery unavailable')
  })
  const target = {
    status: 'issue',
    scope,
    issue: { repository: 'acme/app', number: 42, state: 'OPEN', author: 'automation', body: '', isPullRequest: false },
  } as const
  const abandon = vi.fn(async () => ({ status: 'abandoned' as const, uw: scope }))
  const result = await applyFeatureControl('abandon', { ...authority(gh), target }, {
    abandon,
  } as unknown as UwOperations)

  expect(abandon).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ kind: 'abandoned', confirmed: false, failure: { phase: 'disarm' } })
  expect(featureStopMessage(result)).toContain('disarm-unconfirmed')
  expect(featureStopMessage(result)).toContain('uw-abandoned')
  expect(featureStopMessage(result)).toContain('pull-request-list-incomplete')
  expect(featureStopMessage(result)).toContain('linked PR discovery unavailable')
  expect(featureStopMessage(result)).not.toContain('feature-abandoned')
})

test('disarm presentation exposes documented reasons but not unrelated evidence payload', () => {
  const evidence = {
    note: 'pull-request-list-incomplete',
    payload: 'private root payload',
    disarmed: [
      { pr: 42, error: 'disarm failed GH_TOKEN=gh-fake Authorization: token token-fake \u009b\u202e' },
      { pr: 44, result: { disarmed: true } },
    ],
    discovery: {
      own: {
        incomplete: true,
        evidence: [
          { source: 'linked', status: 'failed', error: 'connection refused', detail: 'private detail' },
          { ownership: [{ pr: 43, status: 'unconfirmed', error: 'pull-request-binding-not-owned' }] },
        ],
      },
    },
  }
  const message = featureStopMessage({
    kind: 'abandoned',
    confirmed: false,
    failure: { phase: 'disarm', evidence },
  })

  expect(message).toContain('pull-request-list-incomplete')
  expect(message).toContain('disarm PR #42: disarm failed')
  expect(message).toContain('own discovery linked failed: connection refused')
  expect(message).toContain('disarm PR #44 result disarmed')
  expect(message).toContain('own ownership PR #43 unconfirmed: pull-request-binding-not-owned')
  expect(message).not.toContain('gh-fake')
  expect(message).not.toContain('token-fake')
  expect(message).not.toContain('\u009b')
  expect(message).not.toContain('\u202e')
  expect(message).toContain('\\u202e')
  expect(message).not.toContain('private root payload')
  expect(message).not.toContain('private detail')
})

test('still confirms abandonment after clean disarm discovery', async () => {
  const gh = vi.fn(async () => '[]')
  const target = {
    status: 'issue',
    scope,
    issue: { repository: 'acme/app', number: 42, state: 'OPEN', author: 'automation', body: '', isPullRequest: false },
  } as const
  const abandon = vi.fn(async () => ({ status: 'abandoned' as const, uw: scope }))
  const result = await applyFeatureControl('abandon', { ...authority(gh), target }, {
    abandon,
  } as unknown as UwOperations)

  expect(result).toEqual({ kind: 'abandoned', confirmed: true })
  expect(featureStopMessage(result)).toBe('feature-abandoned')
})
