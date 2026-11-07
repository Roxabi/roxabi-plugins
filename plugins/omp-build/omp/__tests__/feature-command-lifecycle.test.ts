import { afterEach, describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import type { PreparedEpicReview } from '../../roxabi/epic-range-finalization.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { batch, root } from './feature-command-lifecycle-fixture.ts'

afterEach(() => {
  cleanupFixtureActions()
})

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return {
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }),
    ...impl,
  }
}

const review: PreparedEpicReview = {
  context: {
    repository: 'acme/widgets',
    target: 'acme/widgets#12',
    number: 12,
    candidateGitSHA: 'b'.repeat(40),
    input: null,
    runId: 'review-run',
    operationId: 'final-review',
    subject: { kind: 'epic-range', range: `${'a'.repeat(40)}..${'b'.repeat(40)}` },
  },
  prepared: {
    stage: 'synthesis',
    rootAttemptId: 'root-attempt',
    inventory: {},
    batch: batch('final-review'),
  },
  publisher: {
    authorize: async () => ({ ok: true }),
    publishInventory: async () => ({ ok: true }),
    publishRawContribution: async (_prepared, child) => ({ id: 'contribution', child }),
    completeStage: async () => null,
    publishRequiredStop: async () => ({ ok: true }),
    stop: async () => undefined,
  },
}

function admittedCiCorrection(): Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }> {
  const scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Preserve the confirmed CI correction scope.' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error('expected canonical correction Spec')
  const body = renderIssueSpecBody(canonical.value)
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, null) })
  if (parsed.status !== 'conformant') throw new Error('expected native correction Spec')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    recordId: 'feature-mandate-42',
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, parsed.snapshot),
  })
  const resolved = resolveAcceptedSpec(mandate, [fixtures.historyFrom([mandate])])
  if (!resolved.ok) throw new Error(`unconfirmed correction Spec: ${JSON.stringify(resolved.evidence)}`)
  const ownSpec = resolved.spec
  return {
    kind: 'admitted-ci-correction',
    reference: '#42',
    attributionRecordId: 'ci-attribution-42',
    uw: { ownSpec, children: [] },
  }
}

/** Every result kind that hands work on, one each. */
function handedWork(): ContinueFeatureResult[] {
  return [
    {
      kind: 'action',
      node: 'implement',
      followUp: batch('matrix-action'),
      start: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'matrix-start',
        kind: 'action-receipt',
      },
    },
    {
      kind: 'watch',
      command: "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'",
    },
    { kind: 'review', pr: 7 },
    {
      kind: 'fix',
      reference: '#7',
      reviewId: 'review-7',
      scope: 'preserve the approved region',
      requiredFeatureMandate: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'feature-mandate',
        kind: 'mandate',
      },
    },
    admittedCiCorrection(),
    { kind: 'epic-final-review', review },
  ]
}

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
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {},
      featureContinuationInhibited: () => false,
      markFeatureBatch() {
        starts.push('batch')
      },
      startReview: async () => {
        starts.push('review')
      },
      startFix: async () => {
        starts.push('fix')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }) }
      },
      startAdmittedCiCorrection: async () => {
        starts.push('admitted-ci-correction')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }) }
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

  it('gives framing guidance without a refusal, since moving would not change it', async () => {
    const fixture = principal(async () => ({ kind: 'operator-decision', reason: 'needs-framing' }))
    await runInstalledFeatureCommand('ship the billing export', fixture.value)
    expect(fixture.starts).toEqual([])
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('skill://grilling')
    expect(fixture.sent[0]).not.toContain('principal-dispatch-refused')
    expect(fixture.sent[0]).not.toContain('session-cwd')
  })

  it('starts no work the workflow hands back and names what it refused', async () => {
    for (const result of handedWork()) {
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
})

describe('prepared epic final review delivery', () => {
  function host(
    continueFeature: FeatureWorkflow['continueFeature'],
    prepareEpicRangeReview: (preparedReview: PreparedEpicReview, onComplete: () => Promise<void>) => Promise<void>,
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
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {},
      featureContinuationInhibited: () => inhibited,
      markFeatureBatch() {},
      startReview: async () => {
        starts.push('review')
      },
      startFix: async () => {
        starts.push('fix')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }) }
      },
      startAdmittedCiCorrection: async (input) => {
        corrections.push(input)
        starts.push('admitted-ci-correction')
        return { terminal: Promise.resolve({ status: 'stopped', diagnostics: [] }) }
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
    for (const result of handedWork()) await deliverFeatureResult('#42', result, fixture.value)
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
    for (const result of handedWork()) await deliverFeatureResult('#42', result, fixture.value)
    expect(fixture.starts).toEqual(['action', 'watch', 'review', 'fix', 'admitted-ci-correction', 'epic-final-review'])
    expect(fixture.corrections).toMatchObject([{ reference: '#42', attributionRecordId: 'ci-attribution-42' }])
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
      'feature-stopped: done',
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
      async (_review, onComplete) => onComplete(),
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
        await onComplete()
      },
      () => inhibited,
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(continued).toBe(false)
    expect(fixture.sent).toEqual([])
  })
})
