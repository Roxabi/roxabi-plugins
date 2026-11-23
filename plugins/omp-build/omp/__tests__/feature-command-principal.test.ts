import { describe, expect, it, vi } from 'vitest'
import type { FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { commandComposition } from './feature-command-fixture.ts'

vi.mock('../host-plugin-pin.ts', () => ({ hostPluginPin: vi.fn(async () => undefined) }))

describe('principal refusal stays one message', () => {
  function principal(continueFeature: FeatureWorkflow['continueFeature']) {
    return commandComposition('/principal', { principalCwd: () => true, featureWorkflow: { continueFeature } })
  }

  it('names the operator decision that stopped the workflow on the one refusal line', async () => {
    const fixture = principal(async () => ({ kind: 'operator-decision', reason: 'needs-scope' }))
    await fixture.run('#895')
    expect(fixture.sent).toEqual([
      'session-cwd /principal\nfeature-stopped: principal-dispatch-refused: operator-decision:needs-scope',
    ])
  })

  it('names a block reason and its diagnostics', async () => {
    const fixture = principal(async () => ({
      kind: 'blocked',
      reason: 'base-not-current',
      diagnostics: [{ code: 'base', message: 'origin/main is unreachable' }],
    }))
    await fixture.run('#4')
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('principal-dispatch-refused')
    expect(fixture.sent[0]).toContain('base-not-current')
    expect(fixture.sent[0]).toContain('origin/main is unreachable')
  })

  it('names the error a failing workflow raised', async () => {
    const fixture = principal(async () => {
      throw new Error('issue-unreadable')
    })
    await fixture.run('#4')
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('issue-unreadable')
  })

  it('refuses an unknown workflow result without starting framing', async () => {
    const fixture = principal(async () => ({ kind: 'bogus' }) as never)
    await fixture.run('#42')
    expect(fixture.framing).not.toHaveBeenCalled()
    expect(fixture.sent).toEqual([
      'session-cwd /principal\nfeature-stopped: principal-dispatch-refused: workflow-result: bogus',
    ])
  })
})
