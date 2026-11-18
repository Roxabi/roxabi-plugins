import { missingContextOutputSchema } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { citedOperationIntegrity, recordRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectNativeTerminal } from './native-terminal.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import type { ContextDisposition } from './workflow-context-disposition-schema.ts'
import { contextNativeNegativeValid } from './workflow-context-native-negative.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { authenticateWorkflowReceiptPair, workflowContextChain } from './workflow-context-terminal.ts'
import {
  bindExternalRef,
  historyFor,
  type MandateRecord,
  type ReceiptRecord,
  receiptStartKey,
  recordsOf,
} from './workflow-control.ts'
import { planDigest, planOutputSchema, producerImplementationOutputSchema } from './workflow-output-schema.ts'
import { PLAN_REVIEW_SPECIALISTS } from './workflow-receipt-schema.ts'
import { sameAssessInputs } from './workflow-spec-assessment.ts'

type MandateRef = ExternalRecordRef & { kind: 'mandate' }
export type ContextNegativeInspection = Readonly<{
  kind: 'context-negative-inspection'
  mandate: MandateRef
  negative: ContextDisposition['negative']
}>
export type InspectedContextNegative = Readonly<{
  inspection: ContextNegativeInspection
  mandate: MandateRecord
  negativeLeaf: ReceiptRecord
  negativeChain: readonly ReceiptRecord[]
  negativeStartKeys: ReadonlySet<string>
}>
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)
const refuse = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', 'Context negative inspection is not authenticated')],
})

function reviewProof(
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>,
  home: DecodedHistory,
): boolean {
  if (
    payload.slots.length !== PLAN_REVIEW_SPECIALISTS.length ||
    new Set(payload.slots.map((slot) => slot.slotId)).size !== payload.slots.length ||
    PLAN_REVIEW_SPECIALISTS.some((role) => payload.slots.filter((slot) => slot.specialist === role).length !== 1)
  )
    return false
  const drafts = recordsOf(home).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'plan' &&
      record.payload.phase === 'result' &&
      record.payload.actionId === payload.exactInputs.draftActionId &&
      sameRef(record.payload.mandate, payload.mandate),
  )
  const draft = drafts[0]
  if (
    drafts.length !== 1 ||
    draft?.payload.action !== 'plan' ||
    draft.payload.phase !== 'result' ||
    draft.payload.exactInputs.amendsReviewActionId !== null ||
    !authenticateWorkflowReceiptPair(home, draft).ok
  )
    return false
  const draftPayload = draft.payload
  const terminal = inspectNativeTerminal(draft.payload.native.raw)
  const plan = planOutputSchema.safeParse(draftPayload.structured)
  if (
    terminal.reason !== null ||
    !producerOutputValid('plan', terminal.structured) ||
    !equal(terminal.structured, draftPayload.structured) ||
    !plan.success ||
    planDigest(plan.data) !== payload.exactInputs.planDigest
  )
    return false
  const matchesDraft = (inputs: typeof payload.inputs) => {
    const pins = inputs.manifest.deliveryData.filter((pin) => pin.role === 'plan')
    return (
      pins.length === 1 &&
      pins[0]?.selector === '/payload/structured' &&
      pins[0].record.recordId === draft.recordId &&
      sameRef(pins[0].record, { scope: home.source.scope, kind: 'action-receipt', recordId: draft.recordId }) &&
      pins[0].digest === canonicalValueDigest(draftPayload.structured)
    )
  }
  if (!matchesDraft(payload.inputs)) return false
  const actions = new Set<string>()
  for (const slot of payload.slots) {
    const action = slot.action
    if (
      action === undefined ||
      actions.has(action.actionId) ||
      !validateActionInputs(action.inputs).ok ||
      action.inputs.manifest.purpose !== 'plan-review' ||
      action.inputs.manifest.code.referenceCommit !== action.inputs.manifest.code.base ||
      !equal(action.inputs.manifest.code, payload.inputs.manifest.code) ||
      !equal(action.inputs.manifest.spec, payload.inputs.manifest.spec) ||
      !matchesDraft(action.inputs)
    )
      return false
    actions.add(action.actionId)
  }
  return true
}

function receiptProof(record: ReceiptRecord, mandate: MandateRecord, home: DecodedHistory): boolean {
  const payload = record.payload
  if (
    payload.phase !== 'result' ||
    (payload.action !== 'plan' &&
      payload.action !== 'plan-review' &&
      payload.action !== 'implement' &&
      payload.action !== 'assess-spec') ||
    payload.admission !== null ||
    !contextNativeNegativeValid(record) ||
    !sameRef(payload.mandate, { scope: home.source.scope, kind: 'mandate', recordId: mandate.recordId }) ||
    !authenticateWorkflowReceiptPair(home, record).ok
  )
    return false
  if (!receiptInputsMatch(payload, mandate)) return false
  if (payload.action === 'plan-review') return reviewProof(payload, home)
  if (missingContextOutputSchema.safeParse(payload.structured).success) return true
  if (payload.action !== 'implement') return false
  const parsed = producerImplementationOutputSchema.safeParse(payload.structured)
  return (
    producerOutputValid('delivery-execution', payload.structured) &&
    parsed.success &&
    parsed.data.outcome === 'blocked' &&
    !!parsed.data.missing?.length &&
    parsed.data.commitSHAs.length === 0 &&
    parsed.data.commands.length === 0 &&
    parsed.data.criteria.every((criterion) => criterion.verification === 'unverified')
  )
}

function receiptInputsMatch(
  payload: Extract<ReceiptRecord['payload'], { phase: 'result' }>,
  mandate: MandateRecord,
): boolean {
  const config = mandate.payload.config
  if (
    payload.inputs.manifest.purpose !== payload.action ||
    payload.inputs.manifest.configuration.version !== config.version ||
    payload.inputs.manifest.configuration.digest !== config.digest ||
    payload.inputs.manifest.configuration.serialized !== JSON.stringify(config.effective)
  )
    return false
  if (payload.action !== 'assess-spec') return true
  const operands = payload.inputs.manifest.operands
  return operands?.action === 'assess-spec' && sameAssessInputs(operands.exactInputs, payload.exactInputs)
}

/** Authenticate one unique terminal native-negative chain without resolving accepted Spec authority. */
export function inspectContextNegativeReceipt(
  input: Readonly<{
    mandate: MandateRecord
    histories: readonly DecodedHistory[]
    negative?: ContextDisposition['negative']
  }>,
): Result<InspectedContextNegative> {
  const { mandate, histories } = input
  const scope = { repository: mandate.repository, target: mandate.target }
  const home = historyFor(scope, histories)
  const ref: MandateRef = { scope, kind: 'mandate', recordId: mandate.recordId }
  if (home === null || histories.some((history) => !history.source.complete)) return refuse()
  const bound = bindExternalRef(ref, home)
  if (!bound.ok || !equal(bound.value, mandate) || citedOperationIntegrity(home, mandate.recordId) !== null)
    return refuse()
  const candidates = recordsOf(home).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.phase === 'result' &&
      'scope' in record.payload.mandate &&
      sameRef(record.payload.mandate, ref) &&
      workflowContextNegative(record),
  )
  const allChains = candidates.map((record) => workflowContextChain(home, record))
  if (allChains.some((chain) => chain.status === 'uncertain' || chain.status === 'ambiguous')) return refuse()
  const chains = allChains.filter((chain) => chain.status === 'missing')
  const leaves = [...new Set(chains.map((chain) => chain.leaf.recordId))]
  if (leaves.length !== 1) return refuse()
  const ordered = chains
    .filter((chain) => chain.leaf.recordId === leaves[0])
    .sort((a, b) => b.negatives.length - a.negatives.length)
  const chain = ordered[0]
  if (
    chain === undefined ||
    chains.some((other) =>
      other.negatives.some((record) => !chain.negatives.some((member) => member.recordId === record.recordId)),
    ) ||
    chain.negatives.some((record) => !receiptProof(record, mandate, home))
  )
    return refuse()
  const negative = input.negative ?? {
    source: 'record' as const,
    record: { scope, kind: 'action-receipt' as const, recordId: chain.leaf.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(chain.leaf.payload),
  }
  if (
    negative.record.recordId !== chain.leaf.recordId ||
    recordRefDiagnostics('context negative', negative, histories).length !== 0
  )
    return refuse()
  return {
    ok: true,
    value: {
      inspection: { kind: 'context-negative-inspection', mandate: ref, negative },
      mandate,
      negativeLeaf: chain.leaf,
      negativeChain: chain.negatives,
      negativeStartKeys: new Set(chain.negatives.map(receiptStartKey)),
    },
  }
}
