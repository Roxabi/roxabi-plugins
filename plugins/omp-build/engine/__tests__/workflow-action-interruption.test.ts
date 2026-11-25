import { describe, expect, it } from 'vitest'
import { SCOPE } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import {
  classifyDeliveryAttempts,
  implementationWorld,
  observe,
  planWorld,
} from '../../testing/workflow-interruption-world.ts'
import { startResolution } from '../workflow-action-interruption.ts'
import { controlsOf } from '../workflow-control.ts'
import { interruptedResult, interruptionResolution, withPayload } from './workflow-interruption-support.ts'

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
  it('recognizes an interrupted plan attempt instead of reporting an orphan START', () => {
    const world = planWorld()
    expect(classifyDeliveryAttempts(world.issue([world.start, world.interrupted]))).toMatchObject({
      ok: true,
      value: { unresolved: [{ kind: 'interrupted', action: 'plan' }] },
    })
  })

  it('recognizes an interrupted plan review', () => {
    const world = planWorld()
    const { workflow, version } = world.authenticated
    const digest = workflow.publishedPlanDigest()
    const reviewStart = workflow.planReviewStart(world.mandate, 'act-plan-1', digest, 'act-plan-review-1', version)
    const reviewResult = interruptedResult(
      workflow.planReviewRecord(world.mandate, 'act-plan-1', digest, [], 'act-plan-review-1', version),
      { contributions: [] },
    )
    expect(classifyDeliveryAttempts(world.issue([world.start, world.result, reviewStart, reviewResult]))).toMatchObject(
      { ok: true, value: { unresolved: [{ kind: 'interrupted', action: 'plan-review' }] } },
    )
  })

  it('recognizes an interrupted implementation', () => {
    const world = implementationWorld()
    expect(classifyDeliveryAttempts(world.issue([world.start, world.interrupted]))).toMatchObject({
      ok: true,
      value: { unresolved: [{ kind: 'interrupted', action: 'implement' }] },
    })
  })
})

describe('orphan START before resolution', () => {
  it('recognizes an orphan plan START', () => {
    const world = planWorld()
    expect(classifyDeliveryAttempts(world.issue([world.start]))).toMatchObject({
      ok: true,
      value: { unresolved: [{ kind: 'orphan', action: 'plan' }] },
    })
  })
})

describe('completed results stay on their own paths', () => {
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
  ])('refuses a resolution that reinterprets a $name', ({ result }) => {
    const world = planWorld()
    const completed = result(world)
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: completed,
    })
    expect(
      classifyDeliveryAttempts(world.issue([world.start, completed, ...world.paused, resolution, world.resume])),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
  })
})

describe('neutral operator resolution', () => {
  it('classifies the resolved attempt without changing the historical controls', () => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: world.interrupted,
    })
    const attempt = [world.start, world.interrupted, ...world.paused, resolution]
    const paused = world.issue(attempt)
    expect(controlsOf(paused)).toContainEqual(world.pause)
    expect(classifyDeliveryAttempts(paused)).toMatchObject({ ok: true, value: { unresolved: [] } })
    expect(controlsOf(world.issue([...attempt, world.resume]))).toContainEqual(world.resume)
  })

  it('resolves an orphan START whose RESULT is truly absent', () => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: null,
    })
    expect(
      classifyDeliveryAttempts(world.issue([world.start, ...world.paused, resolution, world.resume])),
    ).toMatchObject({ ok: true, value: { unresolved: [] } })
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
      expect(classifyDeliveryAttempts(issue)).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
      })
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
  ])('refuses a resolution with ambiguous pairing: $name', ({ records }) => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: world.interrupted,
    })
    expect(
      classifyDeliveryAttempts(world.issue([...records(world), ...world.paused, resolution, world.resume])),
    ).toMatchObject({ ok: false })
  })
})
