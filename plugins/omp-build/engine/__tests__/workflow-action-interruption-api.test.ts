import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { nativeDecisionMandate } from '../../testing/workflow-decision-cases/support/native-decision-spec.ts'
import { shippedMandate } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputManifest } from '../action-input-schema.ts'
import { implementationReceiptEligible, integrationReceiptEligible } from '../delivery-observation-authentication.ts'
import { producerOutputValid } from '../producer-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { classifyAttempts, interruptionResolutionCandidate, startResolution } from '../workflow-action-interruption.ts'
import { workflowContextNegative } from '../workflow-context-output.ts'
import type { MandateRecord, ReceiptRecord } from '../workflow-control.ts'
import { interruptedResult as isInterruptedResult } from '../workflow-interruption-proof.ts'
import { criterionTarget } from './criterion-admission-fixture.ts'
import {
  appendRecords,
  INTERRUPTED_IMPLEMENTATION_ADMISSION,
  interruptedResult,
  interruptionResolution,
  type PlannedRecord,
  refOf,
  resumeOf,
  STOP_DIAGNOSTIC,
  withPayload,
} from './workflow-interruption-support.ts'

const { historyFrom, implementStart, pauseConfirmed, pauseRequested, rejectedImplementResult } =
  roxabiWorkflowFixtures()

const PUBLISHED = 'e'.repeat(40)

function planned(record: ReceiptRecord, changes: Partial<PlannedRecord>): PlannedRecord {
  return {
    version: 1,
    recordId: record.recordId,
    runId: record.runId,
    operationId: record.operationId,
    repository: record.repository,
    target: record.target,
    kind: record.kind,
    inputs: [...record.inputs],
    payload: { ...record.payload },
    ...changes,
  }
}

/** An integration pair synthesized from the implementation fixtures: same inputs, `integrate` purpose and operands. */
function integrationPair(mandate: MandateRecord, reason: string) {
  const exactInputs = { mandateId: mandate.recordId, planActionId: 'act-plan-1' }
  const implement = implementStart(mandate)
  const manifest = {
    ...implement.payload.inputs.manifest,
    purpose: 'integrate',
    operands: { action: 'integrate', exactInputs },
  }
  const inputs = {
    ...implement.payload.inputs,
    manifest,
    fingerprint: actionInputDigest(manifest as unknown as ActionInputManifest),
  }
  const start = planned(implement, {
    recordId: 'act-integrate-1-start',
    operationId: 'op-act-integrate-1-start',
    payload: { ...implement.payload, action: 'integrate', actionId: 'act-integrate-1', exactInputs, inputs },
  })
  const rejected = rejectedImplementResult(mandate)
  const result = planned(rejected, {
    recordId: 'act-integrate-1-result',
    operationId: 'op-act-integrate-1-result',
    inputs: rejected.inputs.map((id) => (id === implement.recordId ? start.recordId : id)),
    payload: {
      ...rejected.payload,
      action: 'integrate',
      actionId: 'act-integrate-1',
      exactInputs,
      inputs,
      start: refOf(start),
      structured: null,
      admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason },
    },
  })
  return { start, result }
}

function pausedWorld() {
  const mandate = nativeDecisionMandate(shippedMandate())
  const request = pauseRequested(mandate)
  const pause = pauseConfirmed(mandate, request)
  return { mandate, request, pause, resume: resumeOf(mandate, pause) }
}

it.each(['implement', 'integrate'] as const)(
  'retains SDK-valid %s context negatives as canonical consumer inputs',
  (action) => {
    const mandate = nativeDecisionMandate(shippedMandate())
    const missing = [
      { locator: { kind: 'information-request', description: 'Policy' }, reason: 'Policy unavailable', targets: [] },
    ]
    const structured =
      action === 'implement'
        ? { outcome: 'missing-context', missing }
        : {
            outcome: 'blocked',
            commitSHAs: ['a'.repeat(40)],
            commands: [],
            criteria: [{ target: criterionTarget('C1'), verification: 'unverified', reason: 'Policy unavailable' }],
            reason: 'Missing policy',
            missing,
          }
    expect(producerOutputValid('delivery-execution', structured)).toBe(true)
    const result =
      action === 'implement' ? planned(rejectedImplementResult(mandate), {}) : integrationPair(mandate, '').result
    const built = parseRecord({
      ...result,
      payload: {
        ...result.payload,
        native: { completion: 'completed', strict: 'valid', raw: null },
        structured,
        admission: null,
        diagnostics: [],
      },
    })
    expect(built.ok).toBe(true)
    if (!built.ok || built.value.kind !== 'action-receipt') throw new Error('Expected canonical negative receipt')
    expect(built.value.payload).toMatchObject({ action, structured, admission: null })
    expect(workflowContextNegative(built.value)).toBe(true)
    const forged = parseRecord({
      ...result,
      payload: {
        ...result.payload,
        native: { completion: 'completed', strict: 'valid', raw: null },
        structured,
        admission: {
          admitted: true,
          commits: ['a'.repeat(40)],
          paths: ['src/file.ts'],
          commands: [],
          remoteBranch: 'feat/42-save',
          remoteTip: 'a'.repeat(40),
          published: true,
          reason: 'forged',
        },
        diagnostics: [],
      },
    })
    expect(forged.ok).toBe(true)
    if (!forged.ok || forged.value.kind !== 'action-receipt') throw new Error('Expected canonical forged receipt')
    expect(
      action === 'implement' ? implementationReceiptEligible(forged.value) : integrationReceiptEligible(forged.value),
    ).toBe(false)
    if (action === 'implement') {
      const partial = parseRecord({
        ...result,
        payload: {
          ...result.payload,
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { outcome: 'blocked', commitSHAs: [], commands: [], criteria: [], reason: 'partial delivery' },
          admission: {
            admitted: true,
            commits: [],
            paths: [],
            commands: [],
            remoteBranch: 'feat/42-save',
            remoteTip: 'a'.repeat(40),
            published: true,
            reason: 'partial',
          },
          diagnostics: [],
        },
      })
      expect(partial.ok).toBe(true)
      if (!partial.ok || partial.value.kind !== 'action-receipt') throw new Error('Expected canonical partial receipt')
      expect(implementationReceiptEligible(partial.value)).toBe(true)
    }
    if (action === 'integrate') {
      const wrongAction = parseRecord({
        ...result,
        payload: {
          ...result.payload,
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: {
            outcome: 'implemented',
            commitSHAs: ['a'.repeat(40)],
            commands: [],
            criteria: [],
            reason: 'done',
          },
          admission: null,
          diagnostics: [],
        },
      })
      expect(wrongAction.ok).toBe(false)
      const blockedWithoutMissing = parseRecord({
        ...result,
        payload: {
          ...result.payload,
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: {
            outcome: 'blocked',
            commitSHAs: [],
            commands: [],
            criteria: [],
            reason: 'not a context negative',
          },
          admission: null,
          diagnostics: [],
        },
      })
      expect(blockedWithoutMissing.ok).toBe(false)
    }
  },
)

describe('interrupted RESULT predicate', () => {
  const LEGACY_STOP = { code: 'action-interrupted', message: 'Native execution interrupted (session-stop)' }

  it('accepts an output-less RESULT only with the canonical host interruption marker', () => {
    const mandate = nativeDecisionMandate(shippedMandate())
    const marked = interruptedResult(rejectedImplementResult(mandate), {
      admission: INTERRUPTED_IMPLEMENTATION_ADMISSION,
    })
    expect(isInterruptedResult(marked)).toBe(true)
    expect(isInterruptedResult(withPayload(marked, { diagnostics: [LEGACY_STOP] }))).toBe(false)
    expect(
      isInterruptedResult(
        withPayload(marked, {
          diagnostics: [
            {
              code: 'action-interrupted',
              message: 'legacy',
              detail: { marker: 'omp-build-host-interruption/1', origin: 'session-stop' },
            },
          ],
        }),
      ),
    ).toBe(false)
    expect(
      isInterruptedResult(
        withPayload(marked, {
          diagnostics: [
            {
              code: 'action-interrupted',
              message: 'no proof',
              detail: { marker: 'omp-build-host-interruption/2', origin: 'session-stop' },
            },
          ],
        }),
      ),
    ).toBe(false)
    expect(
      isInterruptedResult(
        withPayload(marked, {
          admission: {
            ...INTERRUPTED_IMPLEMENTATION_ADMISSION,
            commits: ['a'.repeat(40)],
          },
        }),
      ),
    ).toBe(false)
    expect(
      isInterruptedResult(withPayload(marked, { native: { completion: 'incomplete', strict: 'invalid', raw: null } })),
    ).toBe(false)
    expect(
      isInterruptedResult(withPayload(marked, { native: { completion: 'completed', strict: 'absent', raw: null } })),
    ).toBe(false)
  })

  it('rejects completed implementation results despite typed host reasons', () => {
    const mandate = nativeDecisionMandate(shippedMandate())
    const captured = (reason: string) =>
      withPayload(rejectedImplementResult(mandate), {
        native: { completion: 'completed', strict: 'valid', raw: null },
        admission: { ...INTERRUPTED_IMPLEMENTATION_ADMISSION, reason },
      })
    expect(isInterruptedResult(captured('implementation-remote-unconfirmed'))).toBe(false)
    expect(isInterruptedResult(captured('action-interrupted'))).toBe(false)
    expect(isInterruptedResult(withPayload(captured('action-interrupted'), { diagnostics: [STOP_DIAGNOSTIC] }))).toBe(
      false,
    )
    for (const reason of ['action-interrupted', 'implementation-authority-withdrawn']) {
      const invalid = withPayload(captured(reason), {
        native: { completion: 'completed', strict: 'invalid', raw: null },
        diagnostics: [STOP_DIAGNOSTIC],
      })
      expect(isInterruptedResult(invalid)).toBe(false)
    }
    expect(isInterruptedResult(captured('implementation-admission-refused'))).toBe(false)
    expect(isInterruptedResult(captured('implementation-output-invalid'))).toBe(false)
    expect(isInterruptedResult(captured('remote tip unreachable'))).toBe(false)
  })
})

describe('integration interruption resolution', () => {
  const integration = (base: string, head: string, publishedTip: string) => ({
    kind: 'integration',
    base,
    head,
    publishedTip,
  })

  it('refuses a legacy v1 host-settled effect resolution', () => {
    const world = pausedWorld()
    const { start, result } = integrationPair(world.mandate, 'integration-authority-withdrawn')
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start,
      result,
      effects: integration(world.mandate.payload.base, PUBLISHED, PUBLISHED),
      legacyV1: true,
      executor: { kind: 'host-settled' },
    })
    const issue = appendRecords(historyFrom([world.mandate]), [start, result, world.request, world.pause, resolution])
    expect(startResolution([issue], refOf(start))).toMatchObject({ ok: false })
    expect(classifyAttempts({ histories: [issue], scan: [issue], actions: ['integrate'] })).toMatchObject({ ok: false })
  })

  it('admits a not-dispatched orphan integration without an effect snapshot', () => {
    const world = pausedWorld()
    const { start } = integrationPair(world.mandate, 'integration-authority-withdrawn')
    const resolution = interruptionResolution({ mandate: world.mandate, pause: world.pause, start, result: null })
    const history = appendRecords(historyFrom([world.mandate]), [start, world.request, world.pause, resolution])
    expect(startResolution([history], refOf(start))).toMatchObject({
      ok: true,
      value: { record: { recordId: resolution.recordId, payload: { executor: { kind: 'not-dispatched' } } } },
    })
  })

  it('refuses a resolution whose operation ownership is collided by a malformed contribution', () => {
    const world = pausedWorld()
    const { start } = integrationPair(world.mandate, 'integration-authority-withdrawn')
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start,
      result: null,
    })
    const clean = appendRecords(historyFrom([world.mandate]), [start, world.request, world.pause, resolution])
    expect(startResolution([clean], refOf(start))).toMatchObject({
      ok: true,
      value: { record: { recordId: resolution.recordId } },
    })
    const comment = {
      locator: `${clean.source.scope.target}:comment:collision`,
      nativeId: 'collision',
      body: `<!-- omp-build-record v=1 kind=contribution id=collision operationId=${resolution.operationId} part=2/1 data=eA -->`,
      author: clean.source.expectedAuthor,
      createdAt: '2026-10-21T12:00:00Z',
      updatedAt: '2026-10-21T12:00:00Z',
    }
    const collided = decodeHistory({ ...clean.source, comments: [...clean.source.comments, comment] })
    expect(startResolution([collided], refOf(start))).toMatchObject({ ok: false })
  })

  it.each([
    {
      name: 'a base other than the mandate base branch',
      effects: () => integration('other-base', PUBLISHED, PUBLISHED),
    },
    {
      name: 'a head that is not the published tip',
      effects: (mandate: MandateRecord) => integration(mandate.payload.base, 'f'.repeat(40), PUBLISHED),
    },
    { name: 'no effect snapshot', effects: () => ({ kind: 'none' }) },
  ])('refuses an integration resolution with $name', ({ effects }) => {
    const world = pausedWorld()
    const { start, result } = integrationPair(world.mandate, 'integration-authority-withdrawn')
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start,
      result,
      effects: effects(world.mandate),
    })
    const history = appendRecords(historyFrom([world.mandate]), [start, result, world.request, world.pause, resolution])
    const resolved = startResolution([history], refOf(start))
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.diagnostics.map(({ code }) => code)).toContain('interruption-resolution-invalid')
  })

  it('refuses to resolve an integration RESULT carrying an untyped host code', () => {
    const world = pausedWorld()
    const { start, result } = integrationPair(world.mandate, 'integration-origin-mismatch')
    const resolution = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start,
      result,
    })
    const history = appendRecords(historyFrom([world.mandate]), [start, result, world.request, world.pause, resolution])
    expect(startResolution([history], refOf(start)).ok).toBe(false)
  })
})

describe('start resolution and candidate', () => {
  function implementationAttempt() {
    const world = pausedWorld()
    const start = implementStart(world.mandate)
    const result = interruptedResult(rejectedImplementResult(world.mandate), {
      admission: INTERRUPTED_IMPLEMENTATION_ADMISSION,
    })
    return { ...world, start, result }
  }

  it('distinguishes a proven absent resolution from an invalid one', () => {
    const world = implementationAttempt()
    const unresolved = appendRecords(historyFrom([world.mandate]), [world.start, world.result])
    expect(startResolution([unresolved], refOf(world.start))).toEqual({ ok: true, value: null })
    const forged = interruptionResolution({
      mandate: world.mandate,
      pause: world.pause,
      start: world.start,
      result: world.result,
      effects: { kind: 'none' },
    })
    const invalid = appendRecords(historyFrom([world.mandate]), [
      world.start,
      world.result,
      world.request,
      world.pause,
      forged,
    ])
    expect(startResolution([invalid], refOf(world.start)).ok).toBe(false)
  })

  it('proposes an implementation interruption only under an unlifted pause', () => {
    const world = implementationAttempt()
    const paused = appendRecords(historyFrom([world.mandate]), [world.start, world.result, world.request, world.pause])
    const candidate = interruptionResolutionCandidate({
      histories: [paused],
      mandate: world.mandate,
      start: refOf(world.start),
    })
    expect(candidate).toMatchObject({
      ok: true,
      value: {
        action: 'implement',
        result: { recordId: world.result.recordId },
        pause: { recordId: world.pause.recordId },
      },
    })
    const resumed = appendRecords(historyFrom([world.mandate]), [
      world.start,
      world.result,
      world.request,
      world.pause,
      world.resume,
    ])
    expect(
      interruptionResolutionCandidate({ histories: [resumed], mandate: world.mandate, start: refOf(world.start) }).ok,
    ).toBe(false)
  })
})
