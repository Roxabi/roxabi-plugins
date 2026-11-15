import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { accounted } from '../engine/review-context-authentication.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { workflowOperationProblem } from '../engine/workflow-control.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import { actionRequest, confirmPreparedAction, uwSubject } from '../roxabi/delivery-action.ts'
import type { ActionSubject, RecordInputRef, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { refuseOutsideStage } from '../roxabi/uw-action-stage-closure.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import { fixtureHostReviewClassCatalogues } from './host-catalogue-fixture.ts'
import type { runNestedDeliveryScenario } from './nested-delivery-world.ts'

type NestedContext = Parameters<NonNullable<Parameters<typeof runNestedDeliveryScenario>[3]>>[0]
type AttributionPayload = Extract<ActionReceiptPayload, { action: 'attribute-ci'; phase: 'result' }>
type AttributionReceipt = Extract<CanonicalRecord, { kind: 'action-receipt' }> & { payload: AttributionPayload }
type InheritedFixture = {
  operations: UwOperations
  code: UwActionRequest['code']
  exactInputs: AttributionPayload['exactInputs']
}
type InheritedPositive = {
  history: DecodedHistory | undefined
  receipt: AttributionReceipt
  receiptSubject: Extract<ActionSubject, { kind: 'uw' }>
  intakeSubject: Extract<ActionSubject, { kind: 'uw' }>
  ref: RecordInputRef
}

export async function assertParentRefusals(
  context: NestedContext,
  fixture: InheritedFixture,
  positive: InheritedPositive,
) {
  const { scenario } = context
  const { operations, code, exactInputs } = fixture
  const { history, receipt, receiptSubject, intakeSubject, ref } = positive
  if (!history) throw new Error('nested-attribution-history-missing')
  const operation = history.operations.find((item) => item.recordId === receipt.recordId)
  const template = operation?.parts[0]
  if (!operation || !template) throw new Error('nested-attribution-native-parts-missing')
  const parentRead = await operations.readUw(scenario.middle)
  if (parentRead.accepted.status !== 'accepted') throw new Error('parent-accepted-spec-missing')
  const parentEffective = resolveSpecEffective({
    mode: 'current',
    own: parentRead.accepted.value.ref,
    histories: parentRead.histories,
    graph: parentRead.graph,
  })
  if (!parentEffective.ok) throw new Error(`parent-effective-spec:${JSON.stringify(parentEffective.diagnostics)}`)
  expect(parentEffective.value.own.uw).toEqual(scenario.middle)
  const parentManifest = {
    ...receipt.payload.inputs.manifest,
    subject: { ...receiptSubject, uw: scenario.middle },
    spec: { kind: 'accepted' as const, effective: parentEffective.value },
  }
  const parentClaim = {
    ...receipt,
    payload: {
      ...receipt.payload,
      mandate: { ...receipt.payload.mandate, scope: scenario.middle, recordId: scenario.middleMandate.recordId },
      inputs: {
        ...receipt.payload.inputs,
        manifest: parentManifest,
        fingerprint: actionInputDigest(parentManifest),
      },
    },
  }
  const encoded = encodeParts(parentClaim, 'Closure-only parent subject probe', 65_536)
  if (!encoded.ok) throw new Error(`parent-claim-encoding:${JSON.stringify(encoded.diagnostics)}`)
  const removed = new Set(operation.parts.map((part) => part.locator))
  const parentHistory = decodeHistory({
    ...history.source,
    comments: [
      ...history.source.comments.filter((comment) => !removed.has(comment.locator)),
      ...encoded.value.map((body, index) => ({
        ...template,
        body,
        locator: `parent-claim-${index}`,
        nativeId: `parent-claim-${index}`,
      })),
    ],
  })
  const parentRecord = parentHistory.operations.find((item) => item.recordId === receipt.recordId)?.record
  if (parentRecord?.kind !== 'action-receipt' || !accounted(parentHistory, parentRecord))
    throw new Error(
      `parent-claim-not-accounted:${JSON.stringify({ operation: parentHistory.operations.filter((item) => item.recordId === receipt.recordId), diagnostics: parentHistory.diagnostics })}`,
    )
  expect(workflowOperationProblem(parentHistory)).toBeNull()
  expect(parentRecord.payload.inputs.manifest.subject).toEqual(parentManifest.subject)
  const parentRef = { ...ref, digest: canonicalValueDigest(parentClaim.payload) }
  const closureRequest = actionRequest({
    actionId: 'child-closure-parent-probe',
    purpose: 'correction',
    subject: uwSubject(scenario.leaf, scenario.pullRequest),
    code,
    stageSources: [parentRef],
  })
  const refusal = refuseOutsideStage(
    closureRequest,
    { subject: intakeSubject, correctionRoot: null },
    new Set(),
    [parentHistory],
    fixtureHostReviewClassCatalogues(),
  )
  expect(refusal.ok).toBe(false)
  if (!refusal.ok) expect(refusal.diagnostics.map((item) => item.code)).toEqual(['self-output'])
  const otherScope = refuseOutsideStage(
    {
      ...closureRequest,
      stageSources: [{ ...parentRef, record: { ...parentRef.record, scope: scenario.middle } }],
    },
    { subject: intakeSubject, correctionRoot: null },
    new Set(),
    [parentHistory],
    fixtureHostReviewClassCatalogues(),
  )
  expect(otherScope.ok).toBe(false)
  if (!otherScope.ok) expect(otherScope.diagnostics.map((item) => item.code)).toEqual(['self-output'])
  const parentAttribution = await confirmPreparedAction(
    operations,
    actionRequest({
      actionId: randomUUID(),
      purpose: 'attribute-ci',
      subject: uwSubject(scenario.middle, scenario.pullRequest),
      code,
      operands: { action: 'attribute-ci', exactInputs },
    }),
  )
  expect(parentAttribution.ok, JSON.stringify(parentAttribution)).toBe(false)
  if (!parentAttribution.ok)
    expect(parentAttribution.diagnostics.map((item) => item.code)).toEqual(['action-input-cycle'])
  const parentIntake = await confirmPreparedAction(
    operations,
    actionRequest({
      actionId: randomUUID(),
      purpose: 'correction',
      subject: uwSubject(scenario.middle, scenario.pullRequest),
      code,
      stageSources: [ref],
    }),
  )
  expect(parentIntake.ok, JSON.stringify(parentIntake)).toBe(false)
  if (!parentIntake.ok) expect(parentIntake.diagnostics.map((item) => item.code)).toEqual(['action-input-cycle'])
  const afterParentProbes = await operations.readUw(scenario.leaf)
  const afterParentHistory = afterParentProbes.histories.find(
    (item) => item.source.scope.target === scenario.pullRequest.target,
  )
  expect(afterParentHistory?.operations.map((item) => item.record)).toEqual(
    history?.operations.map((item) => item.record),
  )
}
