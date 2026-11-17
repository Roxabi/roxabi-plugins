import { describe, expect, it } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { SCOPE } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { decide, implementationWorld, observe, planWorld } from '../../testing/workflow-interruption-world.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { startResolution } from '../workflow-action-interruption.ts'
import {
  evidenceCodes,
  INTERRUPTED_IMPLEMENTATION_ADMISSION,
  interruptedResult,
  interruptionResolution,
  withPayload,
} from './workflow-interruption-support.ts'

const { rejectedImplementResult } = roxabiWorkflowFixtures()

const ADOPTED_HEAD = 'c'.repeat(40)
const MISSING_CONTEXT = {
  outcome: 'missing-context',
  missing: [
    {
      locator: { kind: 'information-request', description: 'Deployment region' },
      reason: 'The deployment region is required to plan this change',
      targets: [],
    },
  ],
}

describe('honest incomplete native results', () => {
  it('blocks an interrupted plan attempt instead of reporting an unpaired START', async () => {
    const world = planWorld()
    const decision = await decide(world.issue([world.start, world.interrupted]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-interrupted' })
    expect(evidenceCodes(decision)).toContain('action-interrupted')
  })

  it('blocks an interrupted plan review instead of opening another review', async () => {
    const world = planWorld()
    const { workflow, version } = world.authenticated
    const digest = workflow.publishedPlanDigest()
    const reviewStart = workflow.planReviewStart(world.mandate, 'act-plan-1', digest, 'act-plan-review-1', version)
    const reviewResult = interruptedResult(
      workflow.planReviewRecord(world.mandate, 'act-plan-1', digest, [], 'act-plan-review-1', version),
      { contributions: [] },
    )
    const decision = await decide(world.issue([world.start, world.result, reviewStart, reviewResult]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-interrupted' })
  })

  it('blocks an interrupted implementation instead of treating it as a substantive refusal', async () => {
    const world = implementationWorld()
    const decision = await decide(world.issue([world.start, world.interrupted]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-interrupted' })
    expect(evidenceCodes(decision)).toContain('action-interrupted')
  })
})

describe('orphan START before resolution', () => {
  it('keeps an orphan plan START uncertain', async () => {
    const world = planWorld()
    const decision = await decide(world.issue([world.start]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  it.each([
    { name: 'orphan', result: false, reason: 'action-uncertain' },
    { name: 'interrupted', result: true, reason: 'action-interrupted' },
  ])('refuses an explicit resume while an $name attempt is unresolved', async ({ result, reason }) => {
    const world = planWorld()
    const attempt = result ? [world.start, world.interrupted] : [world.start]
    const issue = world.issue([...attempt, ...world.paused])
    expect(await decide(issue, world.mandate)).toMatchObject({ status: 'paused', confirmed: true })
    const decision = await decide(issue, world.mandate, { explicitResume: true })
    expect(decision).toMatchObject({ status: 'blocked', reason })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('applies the configuration guard before the unresolved-attempt refusal', async () => {
    const world = planWorld()
    const decision = await decide(world.issue([world.start, ...world.paused]), world.mandate, {
      explicitResume: true,
      productVersion: '0.0.0',
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'config-drift' })
  })

  it('still resumes explicitly when no attempt is unresolved', async () => {
    const world = planWorld()
    const decision = await decide(world.issue(world.paused), world.mandate, { explicitResume: true })
    expect(decision).toMatchObject({ status: 'action', action: 'resume', mandateId: world.mandate.recordId })
  })
})

describe('completed results stay on their own paths', () => {
  it('keeps a completed missing-context plan negative terminal for context', async () => {
    const world = planWorld()
    const negative = withPayload(world.result, { structured: MISSING_CONTEXT })
    const decision = await decide(world.issue([world.start, negative]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked' })
    expect(evidenceCodes(decision)).toContain('action-context-missing')
    expect(evidenceCodes(decision)).not.toContain('action-interrupted')
  })

  it('admits only the explicitly selected implementation negative with newly pinned context', async () => {
    const world = implementationWorld()
    const negative = withPayload(rejectedImplementResult(world.mandate), {
      structured: MISSING_CONTEXT,
      admission: null,
    })
    if (negative.payload.phase !== 'result') throw new Error('expected implementation result')
    const old = negative.payload.inputs
    const manifest = {
      ...old.manifest,
      expandedContext: [
        ...old.manifest.expandedContext,
        {
          source: 'record' as const,
          record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
          selector: '/payload' as const,
          digest: canonicalValueDigest(negative.payload),
        },
        {
          source: 'git-file' as const,
          repository: SCOPE.repository,
          commit: old.manifest.code.head,
          path: 'src/region.ts',
          digest: 'a'.repeat(64),
        },
      ],
    }
    const recovery = {
      negative: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
      actionId: 'recovery-action',
      inputs: { ...old, manifest, fingerprint: actionInputDigest(manifest) },
    }
    const issue = world.issue([world.start, negative])
    expect(await decide(issue, world.mandate)).toMatchObject({ status: 'blocked' })
    expect(await decide(issue, world.mandate, { contextRecovery: recovery })).toMatchObject({
      status: 'action',
      action: 'implement',
    })
    expect(await decide(issue, world.mandate, { contextRecovery: recovery, productVersion: '0.0.0' })).toMatchObject({
      status: 'blocked',
      reason: 'config-drift',
    })
    expect(
      await decide(issue, world.mandate, {
        contextRecovery: recovery,
        configVersion: 'recovery-drift',
        supportedConfigVersions: [world.mandate.payload.config.version, 'recovery-drift'],
        configDigest: '0'.repeat(64),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'config-drift' })
    expect(
      await decide(issue, world.mandate, {
        contextRecovery: recovery,
        configDigest: world.mandate.payload.config.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'config-drift' })
    expect(
      await decide(issue, world.mandate, {
        contextRecovery: { ...recovery, negative: { ...recovery.negative, recordId: 'foreign' } },
      }),
    ).toMatchObject({ status: 'blocked' })
    const lineageOnly = { ...manifest, expandedContext: manifest.expandedContext.slice(0, -1) }
    expect(
      await decide(issue, world.mandate, {
        contextRecovery: {
          ...recovery,
          inputs: { ...old, manifest: lineageOnly, fingerprint: actionInputDigest(lineageOnly) },
        },
      }),
    ).toMatchObject({ status: 'blocked' })
    const movedCode = { ...manifest, code: { ...manifest.code, head: 'f'.repeat(40) } }
    expect(
      await decide(issue, world.mandate, {
        contextRecovery: {
          ...recovery,
          inputs: { ...old, manifest: movedCode, fingerprint: actionInputDigest(movedCode) },
        },
      }),
    ).toMatchObject({ status: 'blocked' })
    const incomplete = withPayload(negative, { native: { completion: 'completed', strict: 'invalid', raw: null } })
    const incompleteManifest = {
      ...manifest,
      expandedContext: manifest.expandedContext.map((ref) =>
        ref.source === 'record' && ref.record.recordId === negative.recordId
          ? { ...ref, digest: canonicalValueDigest(incomplete.payload) }
          : ref,
      ),
    }
    expect(
      await decide(world.issue([world.start, incomplete]), world.mandate, {
        contextRecovery: {
          ...recovery,
          inputs: { ...old, manifest: incompleteManifest, fingerprint: actionInputDigest(incompleteManifest) },
        },
      }),
    ).toMatchObject({ status: 'blocked' })
    const otherStart = roxabiWorkflowFixtures().implementStart(world.mandate, 'other-implementation')
    const otherResult = rejectedImplementResult(world.mandate, 'other-implementation')
    expect(
      await decide(world.issue([world.start, negative, otherStart, otherResult]), world.mandate, {
        contextRecovery: recovery,
      }),
    ).toMatchObject({ status: 'blocked' })
    const retryStart = withPayload(world.start, { actionId: recovery.actionId, inputs: recovery.inputs }, 'retry-start')
    const retryBuilt = buildRecord({
      version: 1,
      repository: negative.repository,
      target: negative.target,
      recordId: 'retry-negative',
      runId: negative.runId,
      operationId: 'op-retry-negative',
      kind: 'action-receipt',
      payload: {
        ...negative.payload,
        actionId: recovery.actionId,
        inputs: recovery.inputs,
        start: { scope: SCOPE, kind: 'action-receipt', recordId: retryStart.recordId },
      },
    })
    if (!retryBuilt.ok || retryBuilt.value.kind !== 'action-receipt')
      throw new Error('retry result construction failed')
    const retryNegative = retryBuilt.value
    const repeated = world.issue([world.start, negative, retryStart, retryNegative])
    expect(await decide(repeated, world.mandate, { contextRecovery: recovery })).toMatchObject({ status: 'blocked' })
    expect(evidenceCodes(await decide(repeated, world.mandate))).toContain('action-context-missing')
    const nextManifest = {
      ...recovery.inputs.manifest,
      expandedContext: [
        ...recovery.inputs.manifest.expandedContext,
        {
          source: 'record' as const,
          record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: retryNegative.recordId },
          selector: '/payload' as const,
          digest: canonicalValueDigest(retryNegative.payload),
        },
        {
          source: 'git-file' as const,
          repository: SCOPE.repository,
          commit: old.manifest.code.head,
          path: 'src/timezone.ts',
          digest: 'b'.repeat(64),
        },
      ],
    }
    const nextRecovery = {
      negative: { scope: SCOPE, kind: 'action-receipt' as const, recordId: retryNegative.recordId },
      actionId: 'second-recovery-action',
      inputs: { ...old, manifest: nextManifest, fingerprint: actionInputDigest(nextManifest) },
    }
    expect(await decide(repeated, world.mandate, { contextRecovery: nextRecovery })).toMatchObject({
      status: 'action',
      action: 'implement',
    })
  })

  it('keeps a completed invalid plan output uncertain rather than interrupted', async () => {
    const world = planWorld()
    const invalid = withPayload(world.result, {
      native: { completion: 'completed', strict: 'invalid', raw: null },
      structured: null,
    })
    const decision = await decide(world.issue([world.start, invalid]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  it('keeps a completed legacy implementation refusal substantive', async () => {
    const world = implementationWorld()
    const legacy = withPayload(rejectedImplementResult(world.mandate), {
      admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason: 'implementation-admission-refused' },
    })
    const decision = await decide(world.issue([world.start, legacy]), world.mandate)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(evidenceCodes(decision)).not.toContain('action-interrupted')
  })

  it.each([
    {
      name: 'missing-context negative',
      result: (world: ReturnType<typeof planWorld>) => withPayload(world.result, { structured: MISSING_CONTEXT }),
    },
    {
      name: 'completed valid draft',
      result: (world: ReturnType<typeof planWorld>) => world.result,
    },
    {
      name: 'completed invalid output',
      result: (world: ReturnType<typeof planWorld>) =>
        withPayload(world.result, {
          native: { completion: 'completed', strict: 'invalid', raw: null },
          structured: null,
        }),
    },
  ])('refuses a resolution that reinterprets a $name', async ({ result }) => {
    const world = planWorld()
    const completed = result(world)
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: completed,
    })
    const decision = await decide(
      world.issue([world.start, completed, ...world.paused, resolution, world.resume]),
      world.mandate,
    )
    expect(decision).toMatchObject({ status: 'blocked', reason: 'interruption-invalid' })
    expect(evidenceCodes(decision)).toContain('interruption-resolution-invalid')
  })
})

describe('neutral operator resolution', () => {
  it('readmits the plan only after the confirmed pause is lifted', async () => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: world.interrupted,
    })
    const attempt = [world.start, world.interrupted, ...world.paused, resolution]
    expect(await decide(world.issue(attempt), world.mandate)).toMatchObject({
      status: 'paused',
      confirmed: true,
      mandateId: world.mandate.recordId,
    })
    expect(await decide(world.issue(attempt), world.mandate, { explicitResume: true })).toMatchObject({
      status: 'action',
      action: 'resume',
    })
    expect(await decide(world.issue([...attempt, world.resume]), world.mandate)).toMatchObject({
      status: 'action',
      action: 'plan',
    })
  })

  it('resolves an orphan START whose RESULT is truly absent', async () => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: null,
    })
    const decision = await decide(world.issue([world.start, ...world.paused, resolution, world.resume]), world.mandate)
    expect(decision).toMatchObject({ status: 'action', action: 'plan' })
  })

  it.each([
    {
      name: 'absent RESULT claimed while one exists',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({ mandate: world.mandate, pause: world.pause, start: world.start, result: null }),
      ],
    },
    {
      name: 'runtime that differs from the mandate',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.pause,
          start: world.start,
          result: world.interrupted,
          proposal: (proposal) => ({
            ...proposal,
            runtime: { ...(proposal.runtime as Record<string, unknown>), productVersion: '0.0.0' },
          }),
        }),
      ],
    },
    {
      name: 'confirmation for another proposal',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.pause,
          start: world.start,
          result: world.interrupted,
          payload: (payload) => ({
            ...payload,
            executor: { kind: 'operator-attested', statement: 'omp-build-executor-cessation/1' },
          }),
        }),
      ],
    },
    {
      name: 'record identity not derived from the START',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.pause,
          start: world.start,
          result: world.interrupted,
          recordId: 'interruption-resolution-other',
        }),
      ],
    },
    {
      name: 'action that differs from the START',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.pause,
          start: world.start,
          result: world.interrupted,
          proposal: (proposal) => ({ ...proposal, action: 'plan-review' }),
        }),
      ],
    },
    {
      name: 'unconfirmed pause request as predecessor',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.request,
          start: world.start,
          result: world.interrupted,
        }),
      ],
    },
    {
      name: 'implementation effects on a plan attempt',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        interruptionResolution({
          mandate: world.mandate,
          pause: world.pause,
          start: world.start,
          result: world.interrupted,
          effects: {
            kind: 'implementation',
            branch: 'feat/42-save',
            adoptedBase: world.start.payload.inputs.manifest.code.head,
            localHead: ADOPTED_HEAD,
            commits: [ADOPTED_HEAD],
            remoteTip: null,
          },
        }),
      ],
    },
  ])('fails closed on a resolution with $name', async ({ name, records }) => {
    const world = planWorld()
    const issue = world.issue([...records(world), ...world.paused, world.resume])
    if (name === 'confirmation for another proposal' || name === 'implementation effects on a plan attempt') {
      const observation = await observe(issue)
      expect(observation).toMatchObject({
        status: 'incomplete',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'legacy-coverage-incomplete' })]),
      })
      expect(
        startResolution([issue], { scope: SCOPE, recordId: world.start.recordId, kind: 'action-receipt' }).ok,
      ).toBe(false)
    } else {
      const decision = await decide(issue, world.mandate)
      expect(decision).toMatchObject({ status: 'blocked', reason: 'interruption-invalid' })
      expect(evidenceCodes(decision)).toContain('interruption-resolution-invalid')
    }
  })

  it.each([
    {
      name: 'a second RESULT for the resolved START',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        withPayload(world.interrupted, {}, 'act-plan-1-result-replayed'),
      ],
    },
    {
      name: 'a second START with the same action id',
      records: (world: ReturnType<typeof planWorld>) => [
        world.start,
        world.interrupted,
        withPayload(world.start, {}, 'act-plan-1-start-replayed'),
      ],
    },
  ])('never progresses past ambiguous pairing: $name', async ({ records }) => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: world.interrupted,
    })
    const decision = await decide(
      world.issue([...records(world), ...world.paused, resolution, world.resume]),
      world.mandate,
    )
    expect(decision).toMatchObject({ status: 'blocked' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })
})
