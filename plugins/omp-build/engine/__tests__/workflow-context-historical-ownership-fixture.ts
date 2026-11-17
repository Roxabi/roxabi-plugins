import { expect } from 'vitest'
import type { FeatureAuthority } from '../../roxabi/feature-continuation-admission.ts'
import type { Scope } from '../../roxabi/feature-engine.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { deliveryCoverage } from '../uw-delivery-coverage.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveAcceptedSpecForAbandonment } from '../workflow-accepted-spec-control.ts'
import { bindingPolicy } from '../workflow-binding-policy.ts'
import {
  type ContextSuccessionInspection,
  contextSuccessionInspectionFrame,
  contextSuccessionInspectionStarts,
  contextSuccessionInspectionSubject,
  createHistoricalAcceptedSpecContext,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
  historicalAcceptedSpecOwnedHistories,
  prepareContextSuccessionInspection,
} from '../workflow-context-succession-inspection.ts'
import { qualifyContextNegative } from '../workflow-context-succession-negative.ts'
import { type MandateRecord, recordsOf } from '../workflow-control.ts'
import { resolveCapturedAssessmentMandate, resolveCapturedWorkMandate } from '../workflow-pr-binding.ts'
import { assertForeignDigestIsolation, assertForeignProofIsolation } from './workflow-context-foreign-owner-fixture.ts'

export function assertHistoricalOwnership(
  histories: readonly DecodedHistory[],
  stale: readonly DecodedHistory[],
  selected: MandateRecord,
  parentTarget: string,
): HistoricalAcceptedSpecContext {
  const mutable = structuredClone(histories)
  const historical = createHistoricalAcceptedSpecContext(mutable)
  if (!historical.ok) throw new Error('Historical snapshot unavailable')
  const owned = historicalAcceptedSpecOwnedHistories(historical.value, mutable)
  if (!owned.ok) throw new Error('Owned historical frame unavailable')
  expect(historicalAcceptedSpecOwnedHistories(historical.value, structuredClone(histories)).ok).toBe(true)
  assertForeignDigestIsolation(historical.value, histories)
  const resolved = resolveAcceptedSpec(selected, histories, undefined, undefined, historical.value)
  expect(resolved.ok).toBe(true)
  const clonedFrame = historicalAcceptedSpecFrame(historical.value, structuredClone(histories), selected)
  if (!clonedFrame.ok) throw new Error(`Cloned historical frame unavailable: ${JSON.stringify(clonedFrame)}`)
  expect(clonedFrame.value.histories).toBe(owned.value)
  expect(resolveAcceptedSpec(selected, structuredClone(histories), undefined, undefined, historical.value)).toEqual(
    resolved,
  )
  expect(Object.isFrozen(owned.value)).toBe(true)
  expect(Object.isFrozen(owned.value[0]?.source)).toBe(true)
  const ownedHome = owned.value[0]
  if (!ownedHome) throw new Error('Owned history unavailable')
  expect(Reflect.set(ownedHome.source, 'complete', false)).toBe(false)
  expect(Reflect.set(ownedHome.source.scope, 'target', 'changed')).toBe(false)
  const afterMutation = historicalAcceptedSpecFrame(historical.value, structuredClone(histories), selected)
  if (!afterMutation.ok) throw new Error('Historical frame unavailable after rejected mutation')
  expect(afterMutation.value.histories).toBe(owned.value)
  expect(resolveAcceptedSpec(selected, histories, undefined, undefined, historical.value)).toEqual(resolved)
  const switching = structuredClone(histories)
  const switchingHome = switching.find((history) => history.source.scope.target === parentTarget)
  if (!switchingHome) throw new Error('Switching history unavailable')
  const heldOperations = switchingHome.operations
  let reads = 0
  Object.defineProperty(switchingHome, 'operations', {
    enumerable: true,
    get: () => (++reads === 2 ? [] : heldOperations),
  })
  const switchingContext = createHistoricalAcceptedSpecContext(switching)
  if (!switchingContext.ok) throw new Error('Switching snapshot unavailable')
  expect(historicalAcceptedSpecOwnedHistories(switchingContext.value, switching).ok).toBe(false)
  expect(resolveAcceptedSpec(selected, switching, undefined, undefined, switchingContext.value)).toEqual(resolved)
  const mutableHome = mutable[0]
  if (!mutableHome) throw new Error('Mutable history unavailable')
  mutableHome.source.complete = false
  expect(historicalAcceptedSpecOwnedHistories(historical.value, mutable).ok).toBe(false)
  expect(historicalAcceptedSpecOwnedHistories(historical.value, stale).ok).toBe(false)
  expect(historicalAcceptedSpecOwnedHistories({} as HistoricalAcceptedSpecContext, histories).ok).toBe(false)
  const foreign = structuredClone(histories)
  const foreignOperation = foreign
    .flatMap((history) => history.operations)
    .find((operation) => operation.authority !== 'foreign')
  if (!foreignOperation) throw new Error('Accounted history operation unavailable')
  foreignOperation.authority = 'foreign'
  expect(historicalAcceptedSpecOwnedHistories(historical.value, foreign).ok).toBe(false)
  return historical.value
}

export function assertSuccessionFrames(
  authority: FeatureAuthority,
  selected: MandateRecord,
  predecessor: MandateRecord,
  negative: { recordId: string },
  PARENT: Scope,
) {
  const evidence = {
    issue: authority.history,
    pullRequest: null,
    parents: authority.parentHistories,
    causal: authority.causal,
  }
  const prepared = prepareContextSuccessionInspection(evidence, selected)
  if (!prepared.ok || !prepared.value) throw new Error(`Succession inspection unavailable: ${JSON.stringify(prepared)}`)
  const inspection = prepared.value
  const successorRef = { scope: PARENT, kind: 'mandate' as const, recordId: selected.recordId }
  const predecessorRef = { scope: PARENT, kind: 'mandate' as const, recordId: predecessor.recordId }
  const frame = contextSuccessionInspectionFrame(
    prepared.value,
    authority.causal.histories,
    successorRef,
    predecessorRef,
  )
  if (!frame.ok || !frame.value) throw new Error(`Predecessor saved-cut frame unavailable: ${JSON.stringify(frame)}`)
  const savedFrame = frame.value
  expect(frame.value.histories.flatMap(recordsOf).some((record) => record.recordId === negative.recordId)).toBe(true)
  assertForeignProofIsolation(
    authority.causal.histories,
    selected,
    inspection,
    successorRef,
    predecessorRef,
    savedFrame,
  )
  expect(
    contextSuccessionInspectionFrame(prepared.value, authority.causal.histories, successorRef, {
      ...predecessorRef,
      recordId: 'unrelated-predecessor',
    }),
  ).toEqual({ ok: true, value: undefined })
  const stale = authority.causal.histories.map((item, index) =>
    index === 0 ? { ...item, source: { ...item.source, complete: false } } : item,
  )
  expect(contextSuccessionInspectionFrame(prepared.value, stale, successorRef, predecessorRef).ok).toBe(false)
  const historical = assertHistoricalOwnership(authority.causal.histories, stale, selected, PARENT.target)
  const copied = contextSuccessionInspectionFrame(
    prepared.value,
    authority.causal.histories,
    successorRef,
    predecessorRef,
  )
  if (!copied.ok || !copied.value) throw new Error('Copied saved-cut frame unavailable')
  const copiedHistory = copied.value.histories[0]
  if (!copiedHistory) throw new Error('Copied history unavailable')
  copiedHistory.source.complete = false
  const intact = contextSuccessionInspectionFrame(
    prepared.value,
    authority.causal.histories,
    successorRef,
    predecessorRef,
  )
  expect(intact.ok && intact.value?.histories[0]?.source.complete).toBe(true)
  function assertAlteredHistories() {
    const competing = structuredClone(authority.causal.histories)
    const home = competing.find((history) => history.source.scope.target === PARENT.target)
    const selection = home?.operations.find(
      (operation) =>
        operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor',
    )
    if (!home || !selection) throw new Error('Successor control unavailable')
    home.operations.push(structuredClone(selection))
    expect(historicalAcceptedSpecOwnedHistories(historical, competing).ok).toBe(false)
    expect(contextSuccessionInspectionFrame(inspection, competing, successorRef, predecessorRef).ok).toBe(false)
    const cyclic = structuredClone(authority.causal.histories)
    const cyclicSelection = cyclic
      .flatMap((history) => history.operations)
      .find(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor',
      )
    if (
      cyclicSelection?.record?.kind !== 'operator-control' ||
      cyclicSelection.record.payload.control !== 'select-successor'
    )
      throw new Error('Successor control unavailable for cycle')
    cyclicSelection.record.payload.predecessor = successorRef
    expect(historicalAcceptedSpecOwnedHistories(historical, cyclic).ok).toBe(false)
    expect(contextSuccessionInspectionFrame(inspection, cyclic, successorRef, predecessorRef).ok).toBe(false)
  }
  assertAlteredHistories()
  expect(
    contextSuccessionInspectionFrame(
      {} as ContextSuccessionInspection,
      authority.causal.histories,
      successorRef,
      predecessorRef,
    ).ok,
  ).toBe(false)
  expect(contextSuccessionInspectionSubject(prepared.value, authority.causal.histories)).toEqual({
    ok: true,
    value: successorRef,
  })
  expect(contextSuccessionInspectionStarts(prepared.value, authority.causal.histories, successorRef).ok).toBe(true)
  const accessorSpoof = Object.defineProperties(
    {},
    {
      read: { get: () => () => new Set() },
      subject: { get: () => () => successorRef },
      frame: { get: () => () => savedFrame },
    },
  ) as ContextSuccessionInspection
  const proxySpoof = new Proxy(prepared.value, {
    get: (_target, property) =>
      property === 'subject' ? () => successorRef : property === 'frame' ? () => savedFrame : () => new Set(),
  })
  const revocable = Proxy.revocable(prepared.value, {})
  revocable.revoke()
  for (const forged of [accessorSpoof, proxySpoof, revocable.proxy]) {
    expect(contextSuccessionInspectionSubject(forged, authority.causal.histories).ok).toBe(false)
    expect(contextSuccessionInspectionStarts(forged, authority.causal.histories, successorRef).ok).toBe(false)
    expect(contextSuccessionInspectionFrame(forged, authority.causal.histories, successorRef, predecessorRef).ok).toBe(
      false,
    )
  }
}

export function assertParentNegative(
  history: (number: number) => DecodedHistory,
  fixture: { original: string },
  metadata: { version: string },
  PARENT: Scope,
) {
  const initial = history(200)
  const predecessor = recordsOf(initial).find((record) => record.kind === 'mandate')
  const negative = recordsOf(initial).find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result',
  )
  if (
    predecessor?.kind !== 'mandate' ||
    negative?.kind !== 'action-receipt' ||
    negative.payload.action !== 'assess-spec' ||
    negative.payload.phase !== 'result'
  )
    throw new Error('Parent assessment negative unavailable')
  expect(negative.payload).toMatchObject({
    start: { scope: PARENT },
    native: { completion: 'completed', strict: 'valid', raw: expect.anything() },
    structured: { outcome: 'missing-context' },
    admission: null,
  })
  const negativeStart = negative.payload.start
  const start = recordsOf(initial).find(
    (record) => record.kind === 'action-receipt' && record.recordId === negativeStart.recordId,
  )
  expect(start).toMatchObject({
    kind: 'action-receipt',
    repository: PARENT.repository,
    target: PARENT.target,
    payload: { action: 'assess-spec', phase: 'start' },
  })
  expect(predecessor.payload.config.productVersion).toBe(metadata.version)
  expect(bindingPolicy(predecessor)).toBe('bounded')
  expect(deliveryCoverage(initial)).toMatchObject({ ok: true, uncovered: false })
  expect(predecessor.payload.ownSpec.version).toBe(fixture.original)
  expect(resolveAcceptedSpec(predecessor, [initial, ...[201, 202, 203].map(history)]).ok).toBe(false)
  const historiesBeforeAbandonment = [initial, ...[201, 202, 203].map(history)]
  expect(resolveCapturedWorkMandate(negative.payload.inputs, historiesBeforeAbandonment).ok).toBe(false)
  expect(resolveCapturedAssessmentMandate(negative.payload.inputs, historiesBeforeAbandonment)).toMatchObject({
    ok: true,
    value: { recordId: predecessor.recordId },
  })
  const unboundPullRequestInputs = {
    ...negative.payload.inputs,
    manifest: {
      ...negative.payload.inputs.manifest,
      subject: {
        kind: 'uw' as const,
        uw: PARENT,
        pullRequest: { repository: PARENT.repository, target: `${PARENT.repository}#999` },
        binding: null,
      },
    },
  }
  expect(resolveCapturedAssessmentMandate(unboundPullRequestInputs, historiesBeforeAbandonment).ok).toBe(true)
  const mandatePin = negative.payload.inputs.manifest.acceptedSources.find((pin) => pin.record.kind === 'mandate')
  if (mandatePin === undefined) throw new Error('Assessment mandate pin unavailable')
  expect(
    resolveCapturedAssessmentMandate(
      {
        ...negative.payload.inputs,
        manifest: {
          ...negative.payload.inputs.manifest,
          acceptedSources: [...negative.payload.inputs.manifest.acceptedSources, mandatePin],
        },
      },
      historiesBeforeAbandonment,
    ).ok,
  ).toBe(false)
  const qualifiedNegative = qualifyContextNegative({ mandate: predecessor, histories: historiesBeforeAbandonment })
  expect(qualifiedNegative, JSON.stringify(qualifiedNegative)).toMatchObject({
    ok: true,
    value: { negativeLeaf: { recordId: negative.recordId } },
  })
  const abandonPrefix = resolveAcceptedSpecForAbandonment(predecessor, historiesBeforeAbandonment)
  expect(abandonPrefix, JSON.stringify(abandonPrefix)).toMatchObject({ ok: true })
  return { predecessor, negative }
}
