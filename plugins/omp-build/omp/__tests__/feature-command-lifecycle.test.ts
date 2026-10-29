import { afterEach, describe, expect, it } from 'vitest'
import { specDigest } from '../../engine/record-digests.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import type { PreparedEpicReview } from '../../roxabi/epic-range-finalization.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import {
  bridgeHarness,
  cleanupFixtureActions,
  fixtureAction,
  root as nativeRoot,
} from '../../testing/review-runtime-support.ts'
import type { NativeBatch } from '../review-runtime/contracts.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'

const root = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  isIdle: () => true,
  localProtocolOptions: { getArtifactsDir: () => consultableProtocolOptions().getArtifactsDir() },
}

afterEach(() => {
  cleanupFixtureActions()
})

function batch(operationId = 'feature-op'): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'feature fixture',
      tasks: [
        {
          name: 'R-workflow-plan',
          agent: 'R-advisor',
          task: 'plan',
          solutionSpace: 'fixed fixture',
          action: fixtureAction('R-workflow-plan'),
        },
      ],
    },
  }
}

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
  const body = 'C1: Preserve the confirmed CI correction scope.'
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Preserve the confirmed CI correction scope.' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error('expected canonical correction Spec')
  const source: AcceptedOwnSpec['ref']['sourceAccepted'] = {
    scope,
    recordId: 'feature-mandate-42',
    kind: 'mandate',
  }
  const ownSpec: AcceptedOwnSpec = {
    ref: { uw: scope, version: canonical.value.version, sourceAccepted: source },
    snapshot: {
      spec: canonical.value,
      raw: { reference: scope.target, body, bodySha256: specDigest(body), lastEditedAt: null },
    },
    tier: 'S',
    children: [],
    chain: [{ kind: 'mandate', source, version: canonical.value.version }],
    sourceRefs: [source],
  }
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

describe('feature continuation seam', () => {
  it('drops an undelivered feature follow-up while continuation is inhibited', () => {
    const controller = new NativeBatchController()
    const prepared = batch('held')
    controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(prepared)
    expect(controller.announce(prepared)).toBe(true)
    controller.inhibitFeatureContinuation()
    expect(controller.consumeFollowUp()).toBeNull()
    controller.inactive()
    const next = batch('blocked')
    controller.activate(next, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(next)
    expect(controller.announce(next)).toBe(false)
    controller.releaseFeatureContinuation()
    expect(controller.featureContinuationInhibited()).toBe(false)
    expect(controller.announce(next)).toBe(true)
  })

  it('calls onSettled once after a confirmed complete result and not from agent_end', async () => {
    const harness = bridgeHarness()
    const { controller } = harness
    const retainedRoot = { ...nativeRoot, ...root }
    const prepared = batch('settled')
    const task = prepared.tasks.tasks[0]
    if (task === undefined) throw new Error('settlement fixture task is missing')
    task.agent = 'R-workflow-plan'
    task.action = fixtureAction('R-workflow-plan', 'R-workflow-plan')
    let completed = 0
    let settled = 0
    controller.observeRootContext(retainedRoot as never)
    controller.activate(prepared, {
      onComplete: async () => {
        completed += 1
      },
      onSettled: async () => {
        settled += 1
      },
      onStop: async () => undefined,
    })
    controller.announce(prepared)
    const data = {
      steps: [
        {
          id: 'step-1',
          change: 'Preserve the confirmed behavior',
          doneWhen: 'The behavior is retained',
          criterionIds: ['C1'],
          evidence: 'Exercise the behavior',
          paths: ['src/feature.ts'],
        },
      ],
      resolutions: [],
    }
    await harness.admitChild(prepared, 'R-workflow-plan', 'task-call:0', {
      toolCallId: 'task-call',
      root: retainedRoot,
    })
    await harness.yieldChild('task-call:0', data)
    await harness.emitBridgeAndSettle(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'task-call:0',
              agent: 'R-workflow-plan',
              exitCode: 0,
              structuredOutput: { status: 'valid', data },
            },
          ],
        },
      },
      retainedRoot,
    )
    expect(completed).toBe(1)
    expect(settled).toBe(1)
    await harness.emitBridge('agent_end', { willContinue: false }, retainedRoot)
    expect(completed).toBe(1)
    expect(settled).toBe(1)
  })
})

describe('native feature profiles', () => {
  it('keeps the four missing actions blocking and separate from the specialist plan review', () => {
    const byName = new Map(nativeFeatureProfiles.map((profile) => [profile.name, profile]))
    expect(byName.get('R-workflow-assess-spec')?.output).toBe('spec-assessment')
    expect(byName.get('R-workflow-plan')?.output).toBe('plan')
    expect(byName.get('R-workflow-implement')?.output).toBe('implementation')
    expect(byName.get('R-workflow-attribute-ci')?.output).toBe('ci-attribution')
    expect(byName.get('R-workflow-plan')?.body).toContain('criterion')
    expect(byName.get('R-workflow-plan')?.body).toContain('paths')
    expect(byName.get('R-workflow-assess-spec')?.body).toContain('exact accepted Spec snapshot')
    expect(byName.get('R-workflow-plan-architect')?.tools).not.toContain('write')
    expect(byName.get('R-workflow-plan-adversarial')?.tools).not.toContain('edit')
  })
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
