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

describe('feature interruption at the command boundary', () => {
  it.each(['joined', 'prejoin'] as const)(
    'attempts the normal pause after a %s interruption outcome only when the join completed',
    async (phase) => {
      const failure = new Error(`${phase}-interruption-failed`)
      const calls: string[] = []
      const fixture = commandComposition(
        '/principal',
        {
          principalCwd: () => true,
          featureWorkflow: {
            continueFeature: async (input) => {
              expect(input.control).toBe('pause')
              calls.push('continue-pause')
              return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
            },
          },
        },
        async (reason) => {
          expect(reason).toBe('pause')
          calls.push('interrupt')
          if (phase === 'prejoin') throw failure
          return { failures: [failure] }
        },
      )

      await fixture.run('pause #42')
      expect(calls).toEqual(phase === 'joined' ? ['interrupt', 'continue-pause'] : ['interrupt'])
      expect(fixture.sent).toEqual([
        ...(phase === 'joined' ? ['pause-unconfirmed: pause-uncertain'] : []),
        `feature-stopped: ${phase}-interruption-failed`,
      ])
    },
  )

  it('reports the combined pause and joined stop failure once', async () => {
    const fixture = commandComposition(
      '/principal',
      {
        principalCwd: () => true,
        featureWorkflow: {
          continueFeature: async () => {
            throw new Error('pause-workflow-failed')
          },
        },
      },
      async () => ({ failures: [new Error('joined-stop-failed')] }),
    )
    await fixture.run('pause #42')
    expect(fixture.sent).toEqual(['feature-stopped: Feature pause and native stop failed'])
  })
})
