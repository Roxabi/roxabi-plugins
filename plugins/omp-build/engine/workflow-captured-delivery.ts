import { canonicalValueDigest } from './action-input.ts'
import type { PinnedFileRef, RecordInputRef } from './action-input-schema.ts'
import { assessCriterionDeclarations } from './criterion-admission.ts'
import {
  implementationReceiptEligible,
  observationAuthenticationDiagnostics,
} from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectNativeTerminal } from './native-terminal.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Json } from './record-values.ts'
import type { Result } from './result.ts'
import { authenticateIntegrationPin } from './review-integration-pin.ts'
import { type IntegrationOutput, integrationOutputSchema } from './uw-integration-schema.ts'
import { inspectIntegrationSources } from './workflow-captured-integration-sources.ts'
import type { CapturedInvocation } from './workflow-captured-inventory.ts'
import { capturedPlanForInvocation } from './workflow-captured-plan.ts'
import { workflowContextNegative } from './workflow-context-terminal.ts'
import type { ReceiptRecord } from './workflow-control.ts'
import { type ImplementationOutput, implementationOutputSchema } from './workflow-output-schema.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

function fail(message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic('unconfirmed', message)] }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalValueDigest(left) === canonicalValueDigest(right)
}

function object(value: Json | undefined): value is { [key: string]: Json } {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function commandProjection(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(({ toolCallId, command, exitCode }) => ({ toolCallId, command, exitCode }))
    : null
}

/** Host completion adds evidence/provenance; producer-owned fields must nevertheless remain conserved. */
function producerConserved(raw: Json | null, output: Json): boolean {
  if (
    !object(raw) ||
    !object(output) ||
    !producerOutputValid('delivery-execution', raw) ||
    raw.outcome !== output.outcome ||
    raw.reason !== output.reason ||
    !same(commandProjection(raw.commands), commandProjection(output.commands))
  )
    return false
  if (
    !Array.isArray(raw.criteria) ||
    !Array.isArray(output.criteria) ||
    !same(
      raw.criteria.map((item) => (object(item) ? item.target : null)),
      output.criteria.map((item) => (object(item) ? item.target : null)),
    )
  )
    return false
  return raw.outcome === 'implemented'
    ? same(raw.commitSHAs, output.commitSHAs)
    : raw.outcome === 'integrated' &&
        same(raw.code, output.code) &&
        same(raw.children, output.children) &&
        same(raw.coverage, output.coverage)
}

type DeliveryPayload = Extract<ReceiptRecord['payload'], { action: 'implement' | 'integrate'; phase: 'result' }>
type AcceptedSpec = Extract<DeliveryPayload['inputs']['manifest']['spec'], { kind: 'accepted' }>

function inspectIntegration(
  item: CapturedInvocation,
  payload: DeliveryPayload,
  spec: AcceptedSpec,
  output: IntegrationOutput,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  const pin: RecordInputRef = {
    source: 'record',
    selector: '/payload/structured/code',
    record: {
      scope: { repository: item.result.repository, target: item.result.target },
      kind: 'action-receipt',
      recordId: item.result.recordId,
    },
    digest: canonicalValueDigest(output.code),
  }
  const authenticated = authenticateIntegrationPin(
    pin,
    { subject: payload.inputs.manifest.subject, spec, mandate: payload.mandate },
    histories,
  )
  if (!authenticated.ok) return authenticated
  return inspectIntegrationSources(item, authenticated.value.output, histories, replay)
}

function inspectCriterionEvidence(
  item: CapturedInvocation,
  payload: DeliveryPayload,
  spec: AcceptedSpec,
  remoteTip: string,
  criteria: IntegrationOutput['criteria'],
  histories: readonly DecodedHistory[],
): Result<void> {
  const declarations = assessCriterionDeclarations({
    spec: spec.effective,
    code: { repository: item.frame.mandate.repository, commit: remoteTip },
    declarations: criteria,
  })
  if (!declarations.ok) return declarations
  const manifest = payload.inputs.manifest
  const pins: PinnedFileRef[] = [
    ...manifest.repositoryReferences,
    ...manifest.plugin.files,
    ...manifest.expandedContext.filter((ref): ref is PinnedFileRef => ref.source === 'git-file'),
  ]
  for (const declaration of criteria) {
    if (declaration.verification !== 'evidence') continue
    for (const evidence of declaration.evidence) {
      const diagnostics = observationAuthenticationDiagnostics(evidence, histories, pins, item.result)
      if (diagnostics.length) return { ok: false, diagnostics }
    }
  }
  return { ok: true, value: undefined }
}

function inspectDeliveryEffect(
  item: CapturedInvocation,
  payload: DeliveryPayload,
  spec: AcceptedSpec,
  admission: NonNullable<DeliveryPayload['admission']>,
  output: ImplementationOutput | IntegrationOutput,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  if (payload.action === 'implement') {
    if (
      !implementationReceiptEligible(item.result) ||
      output.outcome !== 'implemented' ||
      !same(output.commitSHAs, admission.commits) ||
      output.commitSHAs.at(-1) !== admission.remoteTip
    )
      return fail('Captured implementation commits do not match its admitted remote tip')
  } else {
    if (output.outcome !== 'integrated') return fail('Captured integration output is malformed')
    return inspectIntegration(item, payload, spec, output, histories, replay)
  }
  return { ok: true, value: undefined }
}

function inspectDelivery(
  item: CapturedInvocation,
  payload: DeliveryPayload,
  invocations: readonly CapturedInvocation[],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  if (payload.exactInputs.mandateId !== item.frame.mandate.recordId)
    return fail('Captured delivery mandate differs from its authenticated frame')
  const terminal = inspectNativeTerminal(payload.native.raw)
  if (terminal.reason !== null || !producerOutputValid('delivery-execution', terminal.structured))
    return fail('Captured delivery lacks its valid native producer terminal')
  if (workflowContextNegative(item.result)) {
    if (!same(terminal.structured, payload.structured))
      return fail('Captured delivery negative differs from its native terminal')
    return { ok: true, value: undefined }
  }
  const plan = capturedPlanForInvocation(item, invocations)
  if (!plan.ok) return plan
  const spec = payload.inputs.manifest.spec
  const admission = payload.admission
  if (
    spec.kind !== 'accepted' ||
    admission?.admitted !== true ||
    !admission.published ||
    admission.remoteTip === null ||
    admission.remoteBranch !== item.frame.mandate.payload.branch
  )
    return fail('Captured delivery has no conserved published host-effect admission')
  const output =
    payload.action === 'implement'
      ? implementationOutputSchema.safeParse(payload.structured)
      : integrationOutputSchema.safeParse(payload.structured)
  if (
    !output.success ||
    output.data.outcome === 'blocked' ||
    !producerConserved(terminal.structured, payload.structured) ||
    !same(commandProjection(admission.commands), commandProjection(output.data.commands))
  )
    return fail('Captured delivery output differs from its native claim or admitted commands')
  const effect = inspectDeliveryEffect(item, payload, spec, admission, output.data, histories, replay)
  if (!effect.ok) return effect
  return inspectCriterionEvidence(item, payload, spec, admission.remoteTip, output.data.criteria, histories)
}

/** Validate retained admitted effects without re-running their Git effects or today's child completion. */
export function inspectCapturedDeliveries(
  invocations: readonly CapturedInvocation[],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  for (const item of invocations) {
    const payload = item.result.payload
    if (payload.phase !== 'result' || (payload.action !== 'implement' && payload.action !== 'integrate')) continue
    const result = inspectDelivery(item, payload, invocations, histories, replay)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}
