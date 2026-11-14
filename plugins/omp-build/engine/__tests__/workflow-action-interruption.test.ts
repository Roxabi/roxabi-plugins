import { describe, expect, it } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { SCOPE } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { decide, implementationWorld, observe, planWorld } from '../../testing/workflow-interruption-world.ts'
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
