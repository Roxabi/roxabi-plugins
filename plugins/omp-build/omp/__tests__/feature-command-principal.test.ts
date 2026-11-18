import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureAuthority } from '../../roxabi/feature-continuation-admission.ts'
import { applyFeatureControl } from '../../roxabi/feature-continuation-controls.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { handedWork, workflow } from './feature-command-lifecycle-shared-fixture.ts'

afterEach(() => {
  cleanupFixtureActions()
})

describe('principal refusal stays one message', () => {
  function principal(continueFeature: FeatureWorkflow['continueFeature']) {
    const sent: string[] = []
    const starts: string[] = []
    const value: FeatureCommandHost = {
      key: {},
      cwd: '/principal',
      principal: true,
      workflow: workflow({ continueFeature }),
      native: {
        activate() {
          starts.push('activate')
        },
        inactive() {},
        async stopOwned() {},
        async announce() {
          starts.push('announce')
        },
      },
      send: async (message) => {
        sent.push(message)
      },
      status: async () => undefined,
      startFraming: async () => {
        starts.push('framing')
      },
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {
        return true
      },
      featureContinuationInhibited: () => false,
      markFeatureBatch() {
        starts.push('batch')
      },
      startReview: async () => {
        starts.push('review')
      },
      startFix: async () => {
        starts.push('fix')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }), current: () => true }
      },
      startAdmittedCiCorrection: async () => {
        starts.push('admitted-ci-correction')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }), current: () => true }
      },
      prepareEpicRangeReview: async () => {
        starts.push('epic-final-review')
      },
      exec: async () => {
        starts.push('watch')
        return { code: 0, killed: false }
      },
    }
    return { sent, starts, value }
  }
  it('passes the operator-selected coverage into a fresh continuation and does not invent assignments', async () => {
    const scope = { repository: 'acme/app', target: 'acme/app#42' }
    const child = { repository: 'acme/app', target: 'acme/app#43' }
    const ancestor = { repository: 'acme/app', target: 'acme/app#40' }
    const request = {
      parent: { uw: scope, version: 'a'.repeat(64) },
      accepted: null,
      inheritedOwnSpecRefs: [
        {
          uw: ancestor,
          version: 'c'.repeat(64),
          sourceAccepted: { scope: ancestor, kind: 'mandate' as const, recordId: 'ancestor-mandate' },
        },
      ],
      criteria: [{ id: 'C1', statement: 'Deliver' }],
      children: [
        {
          scope: child,
          specVersion: 'b'.repeat(64),
          tier: 'S' as const,
          criteria: [{ id: 'C1', statement: 'Implement' }],
        },
      ],
    }
    const coverage = {
      parent: request.parent,
      assignments: [{ criterion: 'C1' as const, children: [child] as [typeof child] }],
    }
    const received: unknown[] = []
    const fixture = principal(async (input) => {
      received.push({ coverage: input.parentCoverage, basis: input.parentCoverageBasis })
      return input.parentCoverage === undefined
        ? { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest: request }
        : { kind: 'terminal', reason: 'complete' }
    })
    fixture.value.principal = false
    fixture.value.requestParentCoverage = async (shown) => {
      expect(shown).toEqual(request)
      return { kind: 'proposed', coverage }
    }
    await runInstalledFeatureCommand('#42', fixture.value)
    expect(received).toEqual([
      { coverage: undefined, basis: undefined },
      { coverage, basis: request },
    ])
  })

  it('distinguishes explicit removal of final-child coverage from cancellation', async () => {
    const scope = { repository: 'acme/app', target: 'acme/app#42' }
    const source = { scope, kind: 'mandate' as const, recordId: 'parent-mandate' }
    const request = {
      parent: { uw: scope, version: 'a'.repeat(64) },
      accepted: { own: { uw: scope, version: 'a'.repeat(64), sourceAccepted: source }, metadata: source },
      inheritedOwnSpecRefs: [],
      criteria: [{ id: 'C1', statement: 'Deliver' }],
      children: [],
    }
    for (const answer of [{ kind: 'proposed' as const, coverage: null }, { kind: 'cancelled' as const }]) {
      const received: unknown[] = []
      const fixture = principal(async (input) => {
        received.push(input.parentCoverage)
        return input.parentCoverage === undefined
          ? { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest: request }
          : { kind: 'terminal', reason: 'complete' }
      })
      fixture.value.principal = false
      fixture.value.requestParentCoverage = async () => answer
      await runInstalledFeatureCommand('#42', fixture.value)
      expect(received).toEqual(answer.kind === 'proposed' ? [undefined, null] : [undefined])
    }
  })

  it('sends the move instruction once when the workflow returns it', async () => {
    const fixture = principal(async (input) => ({
      kind: 'session-cwd',
      path: input.cwd,
      instruction: `/move ${input.cwd}`,
    }))
    await runInstalledFeatureCommand('#4', fixture.value)
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('/move /principal')
  })

  it('names the operator decision that stopped the workflow on the one refusal line', async () => {
    const fixture = principal(async () => ({ kind: 'operator-decision', reason: 'needs-scope' }))
    await runInstalledFeatureCommand('#895', fixture.value)
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
    await runInstalledFeatureCommand('#4', fixture.value)
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('principal-dispatch-refused')
    expect(fixture.sent[0]).toContain('base-not-current')
    expect(fixture.sent[0]).toContain('origin/main is unreachable')
  })

  it('names the error a failing workflow raised', async () => {
    const fixture = principal(async () => {
      throw new Error('issue-unreadable')
    })
    await runInstalledFeatureCommand('#4', fixture.value)
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('principal-dispatch-refused')
    expect(fixture.sent[0]).toContain('issue-unreadable')
  })

  it('starts no work the workflow hands back and names what it refused', async () => {
    for (const result of handedWork('principal')) {
      const fixture = principal(async () => result)
      await runInstalledFeatureCommand('#42', fixture.value)
      expect(fixture.starts).toEqual([])
      expect(fixture.sent).toHaveLength(1)
      expect(fixture.sent[0]).toContain(`principal-dispatch-refused: workflow-result: ${result.kind}`)
    }
  })

  it('refuses an unknown result as invalid rather than as work', async () => {
    const fixture = principal(async () => ({ kind: 'bogus' }) as unknown as ContinueFeatureResult)
    await runInstalledFeatureCommand('#42', fixture.value)
    expect(fixture.sent).toEqual([
      'session-cwd /principal\nfeature-stopped: principal-dispatch-refused: feature-result-invalid',
    ])
  })
  it.each(['joined', 'prejoin'] as const)(
    'attempts the normal pause after a %s interruption outcome only when the join completed',
    async (phase) => {
      const failure = new Error(`${phase}-interruption-failed`)
      const calls: string[] = []
      const scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
      const mandate = { kind: 'mandate', recordId: `mandate-${phase}`, payload: { role: 'leaf', branch: 'work' } }
      const authority = {
        context: {
          cwd: '/principal',
          gh: async () => {
            throw new Error('unexpected GitHub operation')
          },
          engine: {
            resolveAcceptedSpec: () => ({ ok: true, spec: {} }),
            effectiveMandateRole: () => 'leaf',
            readComposedWorkflowHistory: async () => {
              calls.push('pause-engine-read')
              return { ok: false }
            },
          },
        },
        history: { source: { scope } },
        scope,
        selection: { status: 'applicable', mandate },
        target: null,
        parentHistories: [],
        causal: { histories: [] },
      } as unknown as FeatureAuthority
      const fixture = principal(async (input) => {
        expect(input.control).toBe('pause')
        calls.push('continue-pause')
        return applyFeatureControl('pause', authority)
      })
      fixture.value.interruptOwnedWork = async (reason) => {
        expect(reason).toBe('pause')
        calls.push('interrupt')
        if (phase === 'prejoin') throw failure
        return { failures: [failure] }
      }

      await expect(runInstalledFeatureCommand('pause #42', fixture.value)).rejects.toBe(failure)
      if (phase === 'joined') {
        expect(calls).toEqual(['interrupt', 'continue-pause', 'pause-engine-read'])
        expect(fixture.sent).toEqual(['pause-unconfirmed: pause-uncertain'])
      } else {
        expect(calls).toEqual(['interrupt'])
        expect(fixture.sent).toEqual([])
      }
    },
  )

  it('preserves joined stop, pause workflow, and notification failures at the command boundary', async () => {
    const stopFailure = new Error('joined-stop-failed')
    const pauseFailure = new Error('pause-workflow-failed')
    const notificationFailure = new Error('pause-notification-failed')
    const calls: string[] = []
    const fixture = principal(async (input) => {
      expect(input.control).toBe('pause')
      calls.push('pause')
      throw pauseFailure
    })
    fixture.value.interruptOwnedWork = async (reason) => {
      expect(reason).toBe('pause')
      calls.push('interrupt')
      return { failures: [stopFailure] }
    }
    fixture.value.send = async () => {
      calls.push('send')
      throw notificationFailure
    }

    const failure = await runInstalledFeatureCommand('pause #42', fixture.value).then(
      () => undefined,
      (error: unknown) => error,
    )
    const seen = new Set<unknown>()
    const pending: unknown[] = [failure]
    while (pending.length > 0) {
      const error = pending.pop()
      if (seen.has(error)) continue
      seen.add(error)
      if (error instanceof AggregateError) pending.push(...error.errors)
      if (error instanceof Error && error.cause !== undefined) pending.push(error.cause)
    }
    expect(calls).toEqual(['interrupt', 'pause', 'send'])
    expect(seen.has(stopFailure)).toBe(true)
    expect(seen.has(pauseFailure)).toBe(true)
    expect(seen.has(notificationFailure)).toBe(true)
  })
})
