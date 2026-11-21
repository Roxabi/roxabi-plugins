import { describe, expect, it } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { buildConfirmedFixRecoveryAdoption, prepareFixRecoveryAdoption } from '../fix-recovery-close.ts'
import { assessFixOwnerAdmission } from '../fix-recovery-owner-admission.ts'
import { fixOwnerHostSchema } from '../fix-recovery-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import {
  anchors,
  append,
  closeFixture,
  fixturePromise,
  inputFor,
  observationFixture,
  required,
  withoutRecords,
} from './fix-owner-admission-fixture.ts'
import { recoveryAssociationFixture } from './fix-recovery-association-fixture.ts'

describe('durable correction owner admission', () => {
  it('permits unobserved Linux network metadata only on ordinary-only hosts', async () => {
    const fixture = await fixturePromise
    const host = anchors(fixture.observe().input.histories).opening.payload.common.host
    if (host.kind !== 'linux-qualified') throw new Error('Expected a qualified Linux fixture')
    const admission = { ...host.admission, namespace: { kind: 'linux-abstract', networkNamespace: null } }
    expect(fixOwnerHostSchema.safeParse({ kind: 'ordinary-only', platform: 'linux', admission }).success).toBe(true)
    expect(fixOwnerHostSchema.safeParse({ ...host, admission }).success).toBe(false)
    expect(fixOwnerHostSchema.safeParse(host).success).toBe(true)
    expect(
      fixOwnerHostSchema.safeParse({
        ...host,
        admission: { ...admission, namespace: { kind: 'linux-abstract', networkNamespace: 'another-network' } },
      }).success,
    ).toBe(false)
  })

  it('does not grant recovery from an ordinary-only Linux owner with unobserved network metadata', async () => {
    const fixture = await fixturePromise
    const observed = fixture.observe()
    const [home, pr] = observed.input.histories
    if (!home || !pr) throw new Error('Missing fixture histories')
    const { opening } = anchors(observed.input.histories)
    const host = opening.payload.common.host
    if (host.kind !== 'linux-qualified') throw new Error('Expected a qualified Linux fixture')
    const qualified = assessFixOwnerAdmission(inputFor(fixture, observed.input.histories, 'recovery'))
    expect(qualified, JSON.stringify(qualified)).toMatchObject({ ok: true, value: { status: 'recovery' } })
    const ordinary = required(
      parseRecord({
        ...opening,
        payload: {
          ...opening.payload,
          common: {
            ...opening.payload.common,
            host: {
              kind: 'ordinary-only',
              platform: 'linux',
              admission: { ...host.admission, namespace: { kind: 'linux-abstract', networkNamespace: null } },
            },
          },
        },
      }),
    )
    const histories = [append(withoutRecords(home, [opening.recordId]), ordinary, 94500), pr]
    const result = assessFixOwnerAdmission(inputFor(fixture, histories, 'recovery'))
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('blocks a second ordinary start while a settled interruption still owns the destination', async () => {
    const fixture = await fixturePromise
    const histories = fixture.observe().input.histories
    const result = assessFixOwnerAdmission(inputFor(fixture, histories, 'fresh'))
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('blocks a second start for an opening with no request or settlement', async () => {
    const fixture = await fixturePromise
    const observed = fixture.observe()
    const [home, pr] = observed.input.histories
    if (!home || !pr) throw new Error('Missing fixture histories')
    const { settled } = anchors(observed.input.histories)
    const histories = [
      withoutRecords(home, [settled.recordId]),
      withoutRecords(pr, [fixture.sourceId.recordId, fixture.requestId.recordId]),
    ]
    const result = assessFixOwnerAdmission({
      ...inputFor(fixture, observed.input.histories, 'fresh'),
      histories,
      effectiveHistories: histories,
    })
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('admits fresh intake only after a confirmed C2 close and returns its exact link', async () => {
    const fixture = await fixturePromise
    const closed = closeFixture(fixture)
    const result = assessFixOwnerAdmission(inputFor(fixture, closed.histories, 'fresh'))
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: {
        status: 'fresh',
        afterClose: {
          kind: 'fix-recovery',
          scope: fixture.leaf.pullRequest,
          recordId: closed.confirmed.recordId,
        },
      },
    })
    expect(assessFixOwnerAdmission(inputFor(fixture, closed.histories, 'claim')).ok).toBe(false)
  })

  it('holds the destination again when the exact close-linked fresh owner is opened', async () => {
    const fixture = await fixturePromise
    const closed = closeFixture(fixture)
    const old = closed.opening.payload
    if (old.intent.kind !== 'fresh-intake') throw new Error('Expected fresh fixture owner')
    const owner = {
      ...old.common.owner,
      recordId: 'next-owner',
      operationId: 'next-operation-next-owner',
      runId: 'next-run',
    }
    const sourceReservation = {
      ...old.intent.sourceReservation,
      recordId: 'next-source',
      operationId: 'next-operation-next-source',
      runId: 'next-run',
    }
    const requestReservation = {
      ...old.intent.requestReservation,
      recordId: 'next-request',
      operationId: 'next-operation-next-request',
      runId: 'next-run',
    }
    const next = required(
      parseRecord({
        ...closed.opening,
        recordId: owner.recordId,
        runId: owner.runId,
        operationId: owner.operationId,
        payload: {
          ...old,
          common: { ...old.common, owner, operationPrefix: 'next-operation' },
          intent: {
            kind: 'fresh-intake',
            afterClose: { scope: fixture.leaf.pullRequest, kind: 'fix-recovery', recordId: closed.confirmed.recordId },
            sourceReservation,
            requestReservation,
          },
        },
      }),
    )
    const histories = [append(closed.histories[0], next, 95500), closed.histories[1]]
    const result = assessFixOwnerAdmission(inputFor(fixture, histories, 'fresh'))
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('holds an active lineage when the requested destination differs', async () => {
    const fixture = await fixturePromise
    const histories = fixture.observe().input.histories
    const base = inputFor(fixture, histories, 'fresh')
    const result = assessFixOwnerAdmission({
      ...base,
      destination: { ...base.destination, destinationRef: 'refs/heads/foreign' },
    })
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('holds an unlinked competing owner even after a confirmed close', async () => {
    const fixture = await fixturePromise
    const closed = closeFixture(fixture)
    const other = required(
      parseRecord({
        ...closed.opening,
        recordId: 'competing-owner',
        operationId: 'competing-operation',
        runId: 'competing-run',
        payload: {
          ...closed.opening.payload,
          common: {
            ...closed.opening.payload.common,
            owner: {
              ...closed.opening.payload.common.owner,
              recordId: 'competing-owner',
              operationId: 'competing-operation',
              runId: 'competing-run',
            },
          },
        },
      }),
    )
    const histories = [append(closed.histories[0], other, 96000), closed.histories[1]]
    const result = assessFixOwnerAdmission(inputFor(fixture, histories, 'fresh'))
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })

  it('requires the exact C3 claim and freshly matching facts, and never treats the control as a fresh start', async () => {
    const fixture = await recoveryAssociationFixture(true)
    const source = observationFixture(fixture, true)
    const control = {
      scope: source.common.pullRequest,
      kind: 'fix-recovery' as const,
      runId: 'adopt-run',
      operationId: 'adopt-operation',
      recordId: 'adopt-control',
    }
    const reservation = {
      scope: fixture.leaf.uw,
      kind: 'fix-owner' as const,
      runId: 'claim-run',
      operationId: 'claim-operation',
      recordId: 'claim-owner',
    }
    const nativePreparation = { kind: 'no-native-action' as const }
    const prepared = required(
      prepareFixRecoveryAdoption({
        control,
        claimReservation: reservation,
        observation: source.observation,
        histories: source.histories,
        graph: fixture.leaf.observation.graph,
        nativePreparation,
      }),
    )
    const confirmed = required(
      buildConfirmedFixRecoveryAdoption({
        prepared,
        fresh: prepared,
        histories: source.histories,
        graph: fixture.leaf.observation.graph,
        confirmation: {
          route: 'omp-native-command',
          operationId: control.operationId,
          proposalDigest: prepared.digest,
          confirmedAt: '2026-10-27T12:00:00Z',
        },
      }),
    )
    const confirmedPr = append(source.pr, confirmed, 98000)
    const histories = [source.home, confirmedPr]
    const base = inputFor(fixture, histories, 'claim')
    expect(assessFixOwnerAdmission({ ...base, intent: 'fresh' }).ok).toBe(false)
    expect(assessFixOwnerAdmission(base).ok).toBe(false)
    expect(
      assessFixOwnerAdmission({
        ...base,
        claim: { reservation: { ...reservation, recordId: 'wrong-owner' }, current: source.current, nativePreparation },
      }).ok,
    ).toBe(false)
    const claim = { reservation, current: source.current, nativePreparation }
    const admitted = assessFixOwnerAdmission({ ...base, claim })
    expect(admitted, JSON.stringify(admitted)).toMatchObject({
      ok: true,
      value: { status: 'claim', claimReservation: reservation },
    })
    const otherPreparation = {
      kind: 'prepared' as const,
      causeId: 'foreign-cause',
      actionId: 'foreign-action',
      inputs: acceptedActionInputs(
        fixture.leaf.mandate,
        'correction',
        fixture.leaf.effective,
        fixture.leaf.inputs.manifest.code,
      ),
    }
    expect(assessFixOwnerAdmission({ ...base, claim: { ...claim, nativePreparation: otherPreparation } }).ok).toBe(
      false,
    )
    const changed = {
      ...claim,
      current: { ...source.current, pullRequest: { ...source.current.pullRequest, candidateGitSHA: '2'.repeat(40) } },
    }
    expect(assessFixOwnerAdmission({ ...base, claim: changed }).ok).toBe(false)
    const spent = required(
      buildRecord({
        ...fixture.leaf.pullRequest,
        version: 1,
        kind: 'fix-result',
        recordId: 'spent-result',
        runId: source.opening.runId,
        operationId: 'spent-operation',
        payload: {
          requestId: fixture.requestId.recordId,
          decisionId: fixture.leaf.review.review.payload.decisionId,
          candidateGitSHA: fixture.leaf.head,
          correctionResultIds: [],
          falsificationResultIds: [],
          causeDispositionRefs: [],
        },
      }),
    )
    const spentHistories = [source.home, append(confirmedPr, spent, 99000)]
    expect(
      assessFixOwnerAdmission({ ...base, histories: spentHistories, effectiveHistories: spentHistories, claim }).ok,
    ).toBe(false)
  })

  it('accepts an authenticated ordinary terminal for a later ordinary start but not as a recovery witness', async () => {
    const fixture = await fixturePromise
    const observed = fixture.observe({ review: true })
    const [home, pr] = observed.input.histories
    if (!home || !pr) throw new Error('Missing fixture histories')
    const { settled } = anchors(observed.input.histories)
    const resultRecord = required(
      buildRecord({
        ...fixture.leaf.pullRequest,
        version: 1,
        kind: 'fix-result',
        recordId: 'ordinary-terminal',
        runId: observed.request.runId,
        operationId: 'ordinary-terminal-operation',
        payload: {
          requestId: observed.request.recordId,
          decisionId: fixture.leaf.review.review.payload.decisionId,
          candidateGitSHA: fixture.leaf.head,
          correctionResultIds: [],
          falsificationResultIds: [],
          causeDispositionRefs: [],
        },
      }),
    )
    const histories = [withoutRecords(home, [settled.recordId]), append(pr, resultRecord, 97000)]
    const base = { ...inputFor(fixture, observed.input.histories, 'fresh'), histories, effectiveHistories: histories }
    const fresh = assessFixOwnerAdmission(base)
    expect(fresh, JSON.stringify(fresh)).toMatchObject({ ok: true, value: { status: 'fresh', afterClose: null } })
    expect(assessFixOwnerAdmission({ ...base, intent: 'recovery' }).ok).toBe(false)
  })
})
