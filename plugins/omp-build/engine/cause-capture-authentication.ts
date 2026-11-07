import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { RecordInputRef } from './action-input-refs.ts'
import { type ActionInputs, actionInputsSchema } from './action-input-schema.ts'
import { resolveCauseActionInputs } from './cause-adjudication.ts'
import type { DispositionSource } from './cause-disposition.ts'
import { recordRefDiagnostics } from './delivery-observation-authentication.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { originalContributionAction } from './review-original-action.ts'
import { bindExternalRef } from './workflow-control.ts'

export type PreparedCauseCapture =
  | { kind: 'action'; input: RecordInputRef }
  | { kind: 'raw'; sources: readonly [ExternalRecordRef, ...ExternalRecordRef[]] }

function selected(value: unknown, selector: string): unknown {
  if (selector === '') return value
  if (!selector.startsWith('/')) return undefined
  let result = value
  for (const part of selector.slice(1).split('/')) {
    if (result === null || typeof result !== 'object') return undefined
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    result = (result as Record<string, unknown>)[key]
  }
  return result
}

const refusal = (message: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('cause-source-unconfirmed', message)],
})

/** Identify a decision's exact producer slot from authenticated lineage, not a latest action. */
export function decisionCauseCapture(
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  histories: readonly DecodedHistory[],
): Result<RecordInputRef> {
  const scope = { repository: decision.repository, target: decision.target }
  const history = histories.find((item) => equalScope(item.source.scope, scope))
  if (history === undefined) return refusal('Decision history is unavailable')
  const bound = bindExternalRef({ scope, kind: 'decision', recordId: decision.recordId }, history)
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(decision))
    return refusal('Decision is not authenticated')
  const source = bindExternalRef(
    { scope, kind: 'contribution', recordId: decision.payload.originalContributionId },
    history,
  )
  if (
    !source.ok ||
    source.value.kind !== 'contribution' ||
    source.value.payload.inventoryId === null ||
    source.value.payload.host.slotId === null
  )
    return refusal('Decision producer contribution is unavailable')
  const inventoryRef = { scope, kind: 'review-attempt' as const, recordId: source.value.payload.inventoryId }
  const inventory = bindExternalRef(inventoryRef, history)
  if (!inventory.ok || inventory.value.kind !== 'review-attempt')
    return refusal('Decision producer inventory is unavailable')
  const slotId = source.value.payload.host.slotId
  const index = inventory.value.payload.slots.findIndex((slot) => slot.slotId === slotId)
  const inputs = inventory.value.payload.slots[index]?.action?.inputs
  if (index < 0 || inputs === undefined) return refusal('Decision producer slot has no action inputs')
  return {
    ok: true,
    value: {
      source: 'record',
      record: inventoryRef,
      selector: `/payload/slots/${index}/action/inputs`,
      digest: canonicalValueDigest(inputs),
    },
  }
}

type CaptureAuthentication = {
  context: CauseContext
  capture: RecordInputRef | null
  source: DispositionSource
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
}

function parseCapturedActionInputs(record: CanonicalRecord, selector: string): Result<ActionInputs> {
  const canonicalSelector =
    (record.kind === 'review-attempt' &&
      (/^\/payload\/slots\/(?:0|[1-9]\d*)\/action\/inputs$/.test(selector) || selector === '/payload/inputSnapshot')) ||
    (record.kind === 'action-receipt' && selector === '/payload/inputs')
  if (!canonicalSelector) return refusal('Cause capture does not select a canonical action input')
  const parsed = actionInputsSchema.safeParse(selected(record, selector))
  if (!parsed.success || !validateActionInputs(parsed.data).ok)
    return refusal('Cause capture is not valid action inputs')
  return { ok: true, value: parsed.data }
}

function authenticateActionCapture(input: CaptureAuthentication): Result<ActionInputs | null> {
  const { capture, histories } = input
  if (capture === null) return { ok: true, value: null }
  const errors = recordRefDiagnostics('cause capture', capture, histories)
  if (errors.length) return { ok: false, diagnostics: errors }
  const history = histories.find((item) => equalScope(item.source.scope, capture.record.scope))
  const record = history && bindExternalRef(capture.record, history)
  if (!record?.ok) return refusal('Cause capture record is unavailable')
  const parsed = parseCapturedActionInputs(record.value, capture.selector)
  if (!parsed.ok) return parsed
  const action = parsed.value
  if (
    action.manifest.spec.kind !== 'accepted' ||
    canonicalValueDigest(action.manifest.spec.effective) !== canonicalValueDigest(input.context.effective)
  )
    return refusal('Cause capture does not bind the complete effective Spec')
  return { ok: true, value: action }
}

function authenticateDecisionCapture(
  input: CaptureAuthentication,
  source: Extract<DispositionSource, { kind: 'decision' }>,
  action: ActionInputs | null,
): Result<null> {
  const { capture, histories } = input
  if (action === null) return refusal('Decision requires its synthesis action capture')
  const history = histories.find((item) => equalScope(item.source.scope, source.decision))
  if (!history) return refusal('Decision history is unavailable')
  const producer = resolveCauseActionInputs({ decision: source.decision, history, context: input.context })
  if (!producer.ok) return producer
  if (!producer.value.some((item) => canonicalValueDigest(item) === canonicalValueDigest(action)))
    return refusal('Cause capture is not the decision synthesis action')
  const scope = { repository: source.decision.repository, target: source.decision.target }
  const contribution = bindExternalRef(
    {
      scope,
      recordId: source.decision.payload.originalContributionId,
      kind: 'contribution',
    },
    history,
  )
  if (!contribution.ok || contribution.value.kind !== 'contribution' || contribution.value.payload.inventoryId === null)
    return refusal('Decision synthesis contribution is unavailable')
  const inventory = bindExternalRef(
    {
      scope,
      recordId: contribution.value.payload.inventoryId,
      kind: 'review-attempt',
    },
    history,
  )
  if (!inventory.ok || inventory.value.kind !== 'review-attempt')
    return refusal('Decision synthesis inventory is unavailable')
  const slotId = contribution.value.payload.host.slotId
  const index = inventory.value.payload.slots.findIndex((slot) => slot.slotId === slotId)
  if (
    index < 0 ||
    capture === null ||
    !sameRef(capture.record, { scope, recordId: inventory.value.recordId, kind: 'review-attempt' }) ||
    capture.selector !== `/payload/slots/${index}/action/inputs`
  )
    return refusal('Cause capture does not select the actual synthesis inventory slot')
  return { ok: true, value: null }
}

function authenticateDeclaredProducer(
  input: CaptureAuthentication,
  contribution: Extract<CanonicalRecord, { kind: 'contribution' }>,
  history: DecodedHistory,
  action: ActionInputs | null,
): Result<null> {
  const producer = originalContributionAction(contribution, history)
  if (!producer.ok) return producer
  if (
    producer.value.manifest.spec.kind !== 'accepted' ||
    canonicalValueDigest(producer.value.manifest.spec.effective) !== canonicalValueDigest(input.context.effective)
  )
    return refusal('Contribution producer does not bind the complete effective Spec')
  if (action === null) return refusal('Declared producer cannot use raw capture')
  const ref = {
    scope: { repository: contribution.repository, target: contribution.target },
    recordId: contribution.recordId,
    kind: 'contribution' as const,
  }
  const refs = [
    ...action.manifest.acceptedSources,
    ...action.manifest.deliveryData,
    ...action.manifest.expandedContext,
    ...action.stageSources,
  ]
  if (
    canonicalValueDigest(producer.value) !== canonicalValueDigest(action) &&
    !refs.some(
      (item) =>
        'record' in item &&
        sameRef(item.record, ref) &&
        item.selector === '/payload' &&
        item.digest === canonicalValueDigest(contribution.payload),
    )
  )
    return refusal('Retaining action does not contain the contribution source')
  return { ok: true, value: null }
}

function authenticateRetainedContribution(
  input: CaptureAuthentication,
  contribution: Extract<CanonicalRecord, { kind: 'contribution' }>,
  action: ActionInputs | null,
): Result<null> {
  const scope = { repository: contribution.repository, target: contribution.target }
  const ref = { scope, recordId: contribution.recordId, kind: 'contribution' as const }
  const history = input.histories.find((item) => equalScope(item.source.scope, scope))
  const bound = history && bindExternalRef(ref, history)
  if (!history || !bound?.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(contribution))
    return refusal('Retained contribution is not authenticated')
  if (
    contribution.payload.inventoryId !== null ||
    contribution.payload.host.action !== undefined ||
    contribution.payload.host.slotId !== null
  )
    return authenticateDeclaredProducer(input, contribution, history, action)
  if (
    action !== null &&
    !action.stageSources.some(
      (item) =>
        sameRef(item.record, ref) &&
        item.selector === '/payload' &&
        item.digest === canonicalValueDigest(contribution.payload),
    )
  )
    return refusal('Raw contribution is absent from the retaining stage sources')
  return { ok: true, value: null }
}

/** Authenticate the exact persisted capture and its relationship to the source. */
export function authenticateCauseCapture(input: CaptureAuthentication): Result<null> {
  const authenticated = authenticateActionCapture(input)
  if (!authenticated.ok) return authenticated
  if (input.source.kind === 'decision') return authenticateDecisionCapture(input, input.source, authenticated.value)
  if (input.source.contributions.length === 0) return refusal('Retained output has no source')
  for (const contribution of input.source.contributions) {
    const result = authenticateRetainedContribution(input, contribution, authenticated.value)
    if (!result.ok) return result
  }
  return { ok: true, value: null }
}
