import { z } from 'zod'
import { canonicalValueDigest } from './action-input.ts'
import { recordInputRefSchema } from './action-input-refs.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import type { Result } from './result.ts'
import { scopeSchema } from './schema-primitives.ts'
import { integrationOutputSchema } from './uw-integration-schema.ts'
import { inspectCapturedDeliveries } from './workflow-captured-delivery.ts'
import { inventoryCapturedWork } from './workflow-captured-inventory.ts'
import { inspectCapturedPlans } from './workflow-captured-plan.ts'
import { contextSuccessionReconciliationSchema } from './workflow-context-disposition-schema.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import type { ContextSuccessionAdmission } from './workflow-context-succession.ts'
import { authenticatedChildAdvance } from './workflow-context-succession-child-advance.ts'
import { type MandateRecord, mandateScope } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import { selectWorkflowBinding } from './workflow-pr-binding.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'
import type { ContextSuccessionObservation } from './workflow-reconstruction-types.ts'

const positiveObservationSchema = z.strictObject({
  kind: z.literal('admitted-successor-delivery'),
  control: externalRecordRefSchema,
  receipt: recordInputRefSchema,
  candidate: z.union([
    z.strictObject({
      repository: z.string().min(1),
      branch: z.string().min(1),
      head: gitObjectIdSchema,
      clean: z.literal(true),
      remoteBranch: gitObjectIdSchema.nullable(),
      remoteBase: gitObjectIdSchema,
    }),
    z.strictObject({
      kind: z.literal('parent'),
      repository: z.string().min(1),
      head: gitObjectIdSchema,
      clean: z.literal(true),
      remoteBase: gitObjectIdSchema,
    }),
  ]),
  delivery: contextSuccessionReconciliationSchema.shape.delivery,
  binding: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({ kind: z.literal('pull-request'), scope: scopeSchema, record: externalRecordRefSchema }),
  ]),
})

/** Authenticate the successor's own retained producer and host effects, never a predecessor negative. */
export function authenticateSuccessorDelivery(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  admission: ContextSuccessionAdmission,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
): Result<void> {
  const fail = (): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('unconfirmed', 'Successor delivery effects are not authenticated')],
  })
  if (!positiveObservationSchema.safeParse(observed).success) return fail()
  const scope = mandateScope(mandate)
  const candidate = observed.candidate
  const control = admission.control.payload
  if (control.control !== 'select-successor' || control.contextDisposition === undefined) return fail()
  if (
    !matchesDeliveryCandidate(
      evidence,
      mandate,
      admission,
      observed,
      control.contextDisposition.reconciliation.remote.base.tip,
    )
  )
    return fail()
  const inventory = authenticatedDeliveryInventory(evidence, admission)
  if (!inventory.ok) return inventory
  const macro = planMacro(evidence, mandate, { excludedStarts: admission.disposedStartKeys })
  const plan = macro.amendmentActionId ?? macro.draftActionId
  if (macro.phase !== 'eligible' || plan === null) return fail()
  const own = inventory.value.filter((item) => isOwnDelivery(item, mandate))
  const selected = own[0]
  if (own.length !== 1 || selected === undefined) return fail()
  const result = selected.result
  const payload = result.payload
  if (
    payload.phase !== 'result' ||
    (payload.action !== 'implement' && payload.action !== 'integrate') ||
    payload.admission?.admitted !== true ||
    !matchesDeliveryReceipt(payload, result.recordId, observed, scope, plan, admission.baselineCode.head) ||
    !payload.admission.published ||
    payload.admission.remoteTip !== candidate.head
  )
    return fail()
  if (!matchesAdmittedEffects(payload, result.recordId, evidence, mandate, admission, observed)) return fail()
  return { ok: true, value: undefined }
}

function authenticatedDeliveryInventory(
  evidence: WorkflowEvidence,
  admission: ContextSuccessionAdmission,
): ReturnType<typeof inventoryCapturedWork> {
  const inventory = inventoryCapturedWork(evidence, undefined, admission.disposedStartKeys)
  if (!inventory.ok) return inventory
  const plans = inspectCapturedPlans(inventory.value, evidence.causal.histories)
  if (!plans.ok) return plans
  const delivery = inspectCapturedDeliveries(inventory.value, evidence.causal.histories)
  if (!delivery.ok) return delivery
  return inventory
}

function isOwnDelivery(
  item: Extract<ReturnType<typeof inventoryCapturedWork>, { ok: true }>['value'][number],
  mandate: MandateRecord,
): boolean {
  const payload = item.result.payload
  return (
    payload.phase === 'result' &&
    (payload.action === 'implement' || payload.action === 'integrate') &&
    !workflowContextNegative(item.result) &&
    sameRef(payload.mandate, { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId })
  )
}

function matchesAdmittedEffects(
  payload: Extract<ActionReceiptPayload, { phase: 'result'; action: 'implement' | 'integrate' }>,
  recordId: string,
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  admission: ContextSuccessionAdmission,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
): boolean {
  const candidate = observed.candidate
  if (payload.admission?.admitted !== true) return false
  if (!matchesDeliveryOutput(payload, observed)) return false
  if (
    observed.delivery.integrations.some(
      (item) => item.source.record.recordId !== recordId || !sameRef(item.source.record, observed.receipt.record),
    )
  )
    return false
  if (!matchesDeliveryBinding(evidence, mandate, observed)) return false
  const known = new Set([
    admission.baselineCode.head,
    ...payload.admission.commits,
    ...('kind' in candidate ? [candidate.head] : []),
  ])
  if (
    !known.has(candidate.head) ||
    observed.delivery.commits.some(
      (commit) => commit.code.repository !== mandate.repository || !known.has(commit.code.commit),
    )
  )
    return false
  const causal = evidence.causal.observation.delivery.filter((item) => equalScope(item.uw, mandateScope(mandate)))
  return (
    causal.length <= 1 &&
    (causal.length === 0 || canonicalValueDigest(causal[0]) === canonicalValueDigest(observed.delivery))
  )
}

function matchesDeliveryOutput(
  payload: Extract<ActionReceiptPayload, { phase: 'result'; action: 'implement' | 'integrate' }>,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
): boolean {
  const candidate = observed.candidate
  if (payload.admission?.admitted !== true) return false
  if ('kind' in candidate)
    return (
      payload.action === 'integrate' &&
      payload.admission.remoteBranch === null &&
      observed.binding.kind === 'absent' &&
      observed.delivery.pullRequests.length === 0 &&
      matchesIntegrationOutput(payload.structured, observed, candidate.head)
    )
  return payload.action === 'implement' && payload.admission.remoteBranch === candidate.branch
}

function matchesDeliveryReceipt(
  payload: Extract<ActionReceiptPayload, { phase: 'result'; action: 'implement' | 'integrate' }>,
  recordId: string,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
  scope: MandateRecord['payload']['ownSpec']['uw'],
  plan: string,
  baselineHead: string,
): boolean {
  const candidate = observed.candidate
  return (
    observed.receipt.source === 'record' &&
    observed.receipt.selector === '/payload' &&
    sameRef(observed.receipt.record, { scope, kind: 'action-receipt', recordId }) &&
    observed.receipt.digest === canonicalValueDigest(payload) &&
    payload.exactInputs.planActionId === plan &&
    payload.inputs.manifest.code.head === ('kind' in candidate ? candidate.head : baselineHead)
  )
}

function matchesDeliveryCandidate(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  admission: ContextSuccessionAdmission,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
  baselineBase: string,
): boolean {
  const scope = mandateScope(mandate)
  const candidate = observed.candidate
  if (!equalScope(observed.delivery.uw, scope) || candidate.repository !== scope.repository || candidate.clean !== true)
    return false
  if ('kind' in candidate)
    return (
      mandate.payload.branch === null &&
      candidate.head === candidate.remoteBase &&
      authenticatedChildAdvance(evidence, mandate, admission, candidate.head)
    )
  return (
    candidate.branch === mandate.payload.branch &&
    candidate.head === candidate.remoteBranch &&
    candidate.remoteBase === baselineBase
  )
}

function matchesIntegrationOutput(
  structured: unknown,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
  head: string,
): boolean {
  const output = integrationOutputSchema.safeParse(structured)
  return (
    output.success &&
    output.data.outcome === 'integrated' &&
    output.data.code.head === head &&
    observed.delivery.integrations.length === 1 &&
    observed.delivery.integrations[0]?.source.selector === '/payload/structured/code' &&
    observed.delivery.integrations[0]?.source.digest === canonicalValueDigest(output.data.code) &&
    canonicalValueDigest(observed.delivery.integrations[0]?.code) === canonicalValueDigest(output.data.code)
  )
}

function matchesDeliveryBinding(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  observed: Extract<ContextSuccessionObservation, { kind: 'admitted-successor-delivery' }>,
): boolean {
  const { candidate, delivery, binding: observedBinding } = observed
  if (delivery.pullRequests.length > 1) return false
  const pr = delivery.pullRequests[0]
  if (pr === undefined) return observedBinding.kind === 'absent'
  if (
    'kind' in candidate ||
    observedBinding.kind !== 'pull-request' ||
    !equalScope(observedBinding.scope, pr.pullRequest) ||
    pr.branch !== candidate.branch ||
    pr.base !== mandate.payload.base ||
    pr.head !== candidate.head ||
    pr.baseTip !== candidate.remoteBase
  )
    return false
  const binding = selectWorkflowBinding({
    pullRequest: pr.pullRequest,
    histories: evidence.causal.histories,
    native: { branch: pr.branch, base: pr.base },
  })
  return (
    binding.status === 'bound' &&
    sameRef(binding.mandate, { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId }) &&
    sameRef(observedBinding.record, {
      scope: pr.pullRequest,
      kind: 'workflow-binding',
      recordId: binding.binding.recordId,
    })
  )
}
