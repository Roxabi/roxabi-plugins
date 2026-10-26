import { describe, expect, it } from 'vitest'
import type { PreparedEpicReview } from '../../roxabi/epic-range-finalization.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import type { NativeBatch, NativeExtension } from '../review-runtime/contracts.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'

const root = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

type CapturedHandler = {
  invoke(...args: unknown[]): unknown
}['invoke']

function batch(operationId = 'feature-op'): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'feature fixture',
      tasks: [{ name: 'R-workflow-plan', agent: 'R-advisor', task: 'plan', solutionSpace: 'fixed fixture' }],
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
    const handlers = new Map<string, CapturedHandler>()
    let raw: ((value: unknown) => void) | undefined
    const pi: NativeExtension = createExtensionApiStub({
      events: {
        on: (_event, handler) => {
          raw = handler
          return () => {
            raw = undefined
          }
        },
      },
      on: (event, handler) => handlers.set(event, handler),
      sendUserMessage: async () => undefined,
    })
    const controller = new NativeBatchController()
    installNativeBatchBridge(pi, controller)
    const prepared = batch('settled')
    let completed = 0
    let settled = 0
    controller.observeRootContext(root as never)
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
    await handlers.get('tool_call')?.(
      { toolName: 'task', toolCallId: 'task-call', input: controller.wire(prepared) },
      root,
    )
    await handlers.get('before_subagent_spawn')?.(
      { agent: 'R-advisor', invocationKind: 'task', patterns: [], spawnKey: 'R-workflow-plan' },
      root,
    )
    raw?.({
      id: 'child-1',
      event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'yield-1', args: { data: { plan: [] } } },
    })
    await handlers.get('tool_result')?.(
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'child-1',
              agent: 'R-advisor',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { plan: [] } },
            },
          ],
        },
      },
      root,
    )
    await handlers.get('agent_end')?.({ willContinue: false }, root)
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

  it('names the operator decision that stopped the workflow', async () => {
    const fixture = principal(async () => ({ kind: 'operator-decision', reason: 'needs-scope' }))
    await runInstalledFeatureCommand('#895', fixture.value)
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toContain('principal-dispatch-refused')
    expect(fixture.sent[0]).toContain('operator-decision:needs-scope')
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
    const handed: ContinueFeatureResult[] = [
      {
        kind: 'action',
        node: 'implement',
        followUp: batch('principal-action'),
        start: {
          scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
          recordId: 'principal-start',
          kind: 'action-receipt',
        },
      },
      { kind: 'watch', command: 'ci-watch' },
      { kind: 'review', pr: 7 },
      { kind: 'admitted-ci-correction', reference: '#7', attributionRecordId: 'ci-receipt', scope: 'repair CI' },
    ]
    for (const result of handed) {
      const fixture = principal(async () => result)
      await runInstalledFeatureCommand('#42', fixture.value)
      expect(fixture.starts).toEqual([])
      expect(fixture.sent).toHaveLength(1)
      expect(fixture.sent[0]).toContain('principal-dispatch-refused')
      expect(fixture.sent[0]).toContain(result.kind)
    }
  })
})

describe('prepared epic final review delivery', () => {
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
    return { starts, sent, value }
  }

  function starts(): ContinueFeatureResult[] {
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
      { kind: 'admitted-ci-correction', reference: '#7', attributionRecordId: 'ci-receipt', scope: 'repair CI' },
      { kind: 'epic-final-review', review },
    ]
  }

  it('reports continuation inhibition instead of starting any active feature result', async () => {
    const fixture = resultHost(true)
    for (const result of starts()) await deliverFeatureResult('#42', result, fixture.value)
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
    for (const result of starts()) await deliverFeatureResult('#42', result, fixture.value)
    expect(fixture.starts).toEqual(['action', 'watch', 'review', 'fix', 'admitted-ci-correction', 'epic-final-review'])
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
