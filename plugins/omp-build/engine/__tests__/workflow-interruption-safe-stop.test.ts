import { describe, expect, it } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { SCOPE } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import {
  classifyDeliveryAttempts,
  implementationWorld,
  observe,
  planWorld,
} from '../../testing/workflow-interruption-world.ts'
import { buildRecord } from '../record-construction.ts'
import { abandoned } from '../workflow-control.ts'
import {
  INTERRUPTED_IMPLEMENTATION_ADMISSION,
  interruptionResolution,
  recoveryStart,
  STOP_DIAGNOSTIC,
  withPayload,
} from './workflow-interruption-support.ts'

const { implementStart, rejectedImplementResult } = roxabiWorkflowFixtures()
const ADOPTED_HEAD = 'c'.repeat(40)

describe('legacy implementation recovery tombstone', () => {
  it('keeps a malformed legacy START blocked even after a synthetic abandon record', async () => {
    const world = implementationWorld()
    const legacy = recoveryStart(implementStart(world.mandate, 'act-implement-2'), ADOPTED_HEAD, world.resolution)
    const observation = await observe(world.issue([legacy]))
    expect(observation).toMatchObject({
      status: 'incomplete',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'legacy-coverage-incomplete' })]),
    })
    const built = buildRecord({
      version: 1,
      repository: world.mandate.repository,
      target: world.mandate.target,
      recordId: 'abandon-legacy',
      runId: world.mandate.runId,
      operationId: 'op-abandon-legacy',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-legacy',
        predecessor: null,
        mandate: { scope: SCOPE, recordId: world.mandate.recordId, kind: 'mandate' },
      },
    })
    if (!built.ok) throw new Error('Expected a canonical abandonment')
    const abandonedHistory = world.issue([legacy, built.value])
    expect(abandoned(abandonedHistory, world.mandate)).toBe(true)
    expect(abandonedHistory.operations.find((operation) => operation.recordId === legacy.recordId)).toMatchObject({
      status: 'invalid',
      kind: 'action-receipt',
    })
    expect(await observe(abandonedHistory)).toMatchObject({ status: 'complete' })
  })
})

describe('legacy interruption proof', () => {
  it('rejects a v1 marker and still recognizes a confirmed abandonment', () => {
    const world = planWorld()
    const legacy = withPayload(world.interrupted, {
      diagnostics: [
        {
          code: 'action-interrupted',
          message: 'legacy',
          detail: { marker: 'omp-build-host-interruption/1', origin: 'session-stop' },
        },
      ],
    })
    expect(classifyDeliveryAttempts(world.issue([world.start, legacy]))).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'action-uncertain' })],
    })
    const built = buildRecord({
      version: 1,
      repository: world.mandate.repository,
      target: world.mandate.target,
      recordId: 'abandon-legacy-marker',
      runId: world.mandate.runId,
      operationId: 'op-abandon-legacy-marker',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-legacy-marker',
        predecessor: null,
        mandate: { scope: SCOPE, recordId: world.mandate.recordId, kind: 'mandate' },
      },
    })
    if (!built.ok) throw new Error('Expected a canonical abandonment')
    expect(abandoned(world.issue([world.start, legacy, built.value]), world.mandate)).toBe(true)
  })
})

describe('typed host interruption codes', () => {
  it('keeps completed implementation work out of the interruption classifier despite a typed host reason', () => {
    const world = implementationWorld()
    const captured = withPayload(rejectedImplementResult(world.mandate), {
      native: { completion: 'completed', strict: 'valid', raw: null },
      admission: {
        ...INTERRUPTED_IMPLEMENTATION_ADMISSION,
        commits: [ADOPTED_HEAD],
        reason: 'implementation-push-failed',
      },
    })
    expect(classifyDeliveryAttempts(world.issue([world.start, captured]))).toMatchObject({
      ok: true,
      value: { unresolved: [] },
    })
  })

  it.each([
    {
      name: 'legacy incomplete capture with invalid output',
      changes: {
        native: { completion: 'incomplete', strict: 'invalid', raw: null },
        structured: null,
        admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason: 'action-uncertain' },
      },
    },
    {
      name: 'terminal invalid output',
      changes: {
        native: { completion: 'completed', strict: 'invalid', raw: null },
        structured: null,
        admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason: 'implementation-output-invalid' },
      },
    },
    {
      name: 'legacy admission refusal text',
      changes: { admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason: 'implementation-admission-refused' } },
    },
    {
      name: 'legacy action-interrupted code without the host marker',
      changes: {
        native: { completion: 'incomplete', strict: 'absent', raw: null },
        structured: null,
        admission: INTERRUPTED_IMPLEMENTATION_ADMISSION,
        diagnostics: [{ code: 'action-interrupted', message: 'Native execution interrupted (session-stop)' }],
      },
    },
    {
      name: 'invalid output beside a marked host stop',
      changes: {
        native: { completion: 'incomplete', strict: 'invalid', raw: null },
        structured: null,
        admission: INTERRUPTED_IMPLEMENTATION_ADMISSION,
        diagnostics: [STOP_DIAGNOSTIC],
      },
    },
    {
      name: 'invalid output beside a host authority code',
      changes: {
        native: { completion: 'completed', strict: 'invalid', raw: null },
        structured: null,
        admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason: 'implementation-authority-withdrawn' },
      },
    },
  ])('rejects a resolution for a $name', ({ changes }) => {
    const world = implementationWorld()
    const kept = withPayload(rejectedImplementResult(world.mandate), changes)
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: kept,
    })
    expect(
      classifyDeliveryAttempts(world.issue([world.start, kept, world.request, world.pause, resolution, world.resume])),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
  })

  it.each([
    {
      name: 'legacy incomplete plan with invalid output',
      changes: { native: { completion: 'incomplete', strict: 'invalid', raw: null }, structured: null },
    },
    {
      name: 'plan without output lacking the canonical host marker',
      changes: {
        native: { completion: 'incomplete', strict: 'absent', raw: null },
        structured: null,
        diagnostics: [{ code: 'action-interrupted', message: 'Native execution interrupted (session-stop)' }],
      },
    },
  ])('rejects a resolution for a $name', ({ changes }) => {
    const world = planWorld()
    const legacy = withPayload(world.result, changes)
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: legacy,
    })
    expect(
      classifyDeliveryAttempts(world.issue([world.start, legacy, ...world.paused, resolution, world.resume])),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
  })
})

describe('safe-stop resolution', () => {
  it('excludes a resolved not-dispatched implementation without an effects snapshot', () => {
    const world = implementationWorld()
    expect(
      classifyDeliveryAttempts(
        world.issue([world.start, world.interrupted, world.request, world.pause, world.resolution, world.resume]),
      ),
    ).toMatchObject({ ok: true, value: { unresolved: [] } })
  })

  it('refuses a resolution that ignores a RESULT published after it', () => {
    const world = planWorld()
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: null,
    })
    const attempts = classifyDeliveryAttempts(
      world.issue([world.start, ...world.paused, resolution, world.resume, world.result]),
    )
    expect(attempts).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
    expect(JSON.stringify(attempts)).toContain('late-result')
  })
})
