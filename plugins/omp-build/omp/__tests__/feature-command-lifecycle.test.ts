import { afterEach, describe, expect, it } from 'vitest'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { startDispatch } from '../../roxabi/feature-start-executions.ts'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { root } from './feature-command-lifecycle-fixture.ts'
import { handedWork, review, workflow } from './feature-command-lifecycle-shared-fixture.ts'

afterEach(() => {
  cleanupFixtureActions()
})

describe('prepared epic final review delivery', () => {
  function host(
    continueFeature: FeatureWorkflow['continueFeature'],
    prepareEpicRangeReview: NonNullable<FeatureCommandHost['prepareEpicRangeReview']>,
    inhibited = () => false,
  ) {
    const sent: string[] = []
    return {
      sent,
      value: {
        key: {},
        cwd: root.cwd,
        principal: false,
        workflow: workflow({ continueFeature }),
        native: { activate() {}, inactive() {}, async stopOwned() {}, async announce() {} },
        send: async (message: string) => {
          sent.push(message)
        },
        status: async () => undefined,
        startFraming: async () => {
          throw new Error('unexpected-framing')
        },
        inhibitFeatureContinuation() {},
        releaseFeatureContinuation() {},
        featureContinuationInhibited: inhibited,
        markFeatureBatch() {},
        prepareEpicRangeReview,
        exec: async () => ({ code: -1, killed: true }),
      },
    }
  }

  function resultHost(inhibited: boolean) {
    const starts: string[] = []
    const sent: string[] = []
    const corrections: Array<Parameters<NonNullable<FeatureCommandHost['startAdmittedCiCorrection']>>[0]> = []
    const value: FeatureCommandHost = {
      key: {},
      cwd: root.cwd,
      principal: false,
      workflow: workflow(),
      native: {
        activate() {
          starts.push('action')
        },
        inactive() {},
        async stopOwned() {},
        async announce() {},
      },
      send: async (message) => {
        sent.push(message)
      },
      status: async () => undefined,
      startFraming: async () => {
        starts.push('framing')
      },
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {},
      featureContinuationInhibited: () => inhibited,
      markFeatureBatch() {},
      startReview: async () => {
        starts.push('review')
      },
      startFix: async () => {
        starts.push('fix')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }), current: () => true }
      },
      startAdmittedCiCorrection: async (input) => {
        corrections.push(input)
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
    return { starts, sent, corrections, value }
  }

  it('reports continuation inhibition instead of starting any active feature result', async () => {
    const fixture = resultHost(true)
    for (const result of handedWork('inhibited')) await deliverFeatureResult('#42', result, fixture.value)
    expect(fixture.starts).toEqual([])
    expect(fixture.sent).toEqual([
      'feature-stopped: continuation-inhibited',
      'feature-stopped: continuation-inhibited',
      'feature-stopped: continuation-inhibited',
      'feature-stopped: continuation-inhibited',
      'feature-stopped: continuation-inhibited',
      'feature-stopped: continuation-inhibited',
    ])
  })

  it('starts every active feature result when continuation is not inhibited', async () => {
    const fixture = resultHost(false)
    for (const result of handedWork('active')) await deliverFeatureResult('#42', result, fixture.value)
    expect(fixture.starts).toEqual(['action', 'watch', 'review', 'fix', 'admitted-ci-correction', 'epic-final-review'])
    expect(fixture.corrections).toMatchObject([{ reference: '#42', attributionRecordId: 'ci-attribution-42' }])
  })

  it.each(['fix', 'admitted-ci-correction'] as const)('discards stale selection after %s completes', async (kind) => {
    for (const selectedKind of ['fix', 'action'] as const) {
      const fixture = resultHost(false)
      const selected = Promise.withResolvers<void>()
      const releaseSelection = Promise.withResolvers<void>()
      let runCurrent = true
      let starts = 0
      const initial = handedWork('active').find((result) => result.kind === kind)
      const selectedResult = handedWork('active').find((result) => result.kind === selectedKind)
      if (!initial || !selectedResult) throw new Error('missing feature result fixture')
      const next =
        selectedResult.kind === 'action'
          ? { ...selectedResult, start: { ...selectedResult.start, recordId: `stale-${kind}-action` } }
          : selectedResult
      fixture.value.workflow = workflow({
        continueFeature: async (input) => {
          expect(input.owned?.()).toBe(true)
          selected.resolve()
          await releaseSelection.promise
          expect(input.owned?.()).toBe(false)
          return next
        },
      })
      const start = async (_input: unknown, current?: () => boolean) => {
        starts++
        return {
          terminal: Promise.resolve({
            status: 'complete' as const,
            recordId: 'fix-result',
            kind: 'fix-result' as const,
          }),
          current: () => runCurrent && (current?.() ?? true),
        }
      }
      fixture.value.startFix = start
      fixture.value.startAdmittedCiCorrection = start
      await deliverFeatureResult('#42', initial, fixture.value, () => true)
      await selected.promise
      runCurrent = false
      releaseSelection.resolve()
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
      expect(starts).toBe(1)
      expect(fixture.starts).toEqual([])
      expect(fixture.corrections).toEqual([])
      if (next.kind === 'action') expect(startDispatch(next.start)).toEqual({ kind: 'not-activated' })
    }
  })

  it('still reports passive feature results while continuation is inhibited', async () => {
    const fixture = resultHost(true)
    const passive: ContinueFeatureResult[] = [
      { kind: 'session-cwd', path: root.cwd, instruction: `/move ${root.cwd}` },
      { kind: 'paused', confirmed: false, reason: 'unconfirmed' },
      { kind: 'abandoned', confirmed: true },
      { kind: 'blocked', reason: 'refused' },
      { kind: 'terminal', reason: 'done' },
      { kind: 'operator-decision', reason: 'hold' },
    ]
    for (const result of passive) await deliverFeatureResult('#42', result, fixture.value)
    expect(fixture.starts).toEqual([])
    expect(fixture.sent).toEqual([
      `session-cwd ${root.cwd}\n/move ${root.cwd}`,
      'pause-unconfirmed: unconfirmed',
      'feature-abandoned',
      'feature-stopped: refused',
      expect.stringMatching(/^feature-done:.*done/),
      'feature-stopped: operator-decision:hold',
    ])
  })

  it('does not continue when final epic publication fails', async () => {
    let continued = false
    const fixture = host(
      async (input) => {
        if (input.control === 'select') return { kind: 'epic-final-review', review }
        continued = true
        return { kind: 'terminal', reason: 'unexpected' }
      },
      async () => {
        throw new Error('epic-final-publication-failed')
      },
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(continued).toBe(false)
    expect(fixture.sent).toEqual(['feature-stopped: epic-final-publication-failed'])
  })

  it('continues after confirmed final epic publication', async () => {
    const fixture = host(
      async (input) =>
        input.control === 'select' ? { kind: 'epic-final-review', review } : { kind: 'terminal', reason: 'complete' },
      async (_review, onComplete) => {
        const deliver = await onComplete(() => true)
        await deliver?.()
      },
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(fixture.sent).toEqual(['feature-stopped: complete'])
  })

  it('does not start next work when epic publication completes under pause inhibition', async () => {
    let inhibited = false
    let continued = false
    const fixture = host(
      async (input) => {
        if (input.control === 'select') return { kind: 'epic-final-review', review }
        continued = true
        return { kind: 'terminal', reason: 'unexpected' }
      },
      async (_review, onComplete) => {
        inhibited = true
        const deliver = await onComplete(() => true)
        await deliver?.()
      },
      () => inhibited,
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(continued).toBe(false)
    expect(fixture.sent).toEqual([])
  })
})
