import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Json } from './record-values.ts'
import type { Result } from './result.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { authenticateWorkflowReceiptPair } from './workflow-context-terminal.ts'
import type { ControlRecord, MandateRecord, ReceiptRecord } from './workflow-control.ts'
import type { OperatorControlPayload } from './workflow-operator-control-schema.ts'
export const INTERRUPTION_RESOLUTION_FORMAT = 'omp-build-interruption-resolution/2' as const
export const INTERRUPTION_RESOLUTION_PREFIX = 'interruption-resolution-' as const
export const INTERRUPTION_ACTIONS = [
  'plan',
  'plan-review',
  'implement',
  'integrate',
  'assess-spec',
  'attribute-ci',
] as const
/** Canonical marker of a host-observed interruption; produced only through `hostInterruptionDiagnostic`. */
export const HOST_INTERRUPTION_MARKER = 'omp-build-host-interruption/2' as const
export type InterruptionAction = (typeof INTERRUPTION_ACTIONS)[number]

export type ResolutionPayload = Extract<OperatorControlPayload, { control: 'resolve-interruption' }>
export type ResolutionRecord = ControlRecord & { payload: ResolutionPayload }
export type ResolutionProposal = Omit<ResolutionPayload, 'proposalDigest' | 'confirmation'>
export type InterruptionResolution = {
  record: ResolutionRecord
  mandate: MandateRecord
  start: ReceiptRecord
  result: ReceiptRecord | null
  /** The bound pause-confirmed predecessor; a resolution is neutral and never consumes it. */
  pause: ControlRecord
}
export type ResolutionIndex = { readonly resolved: ReadonlyMap<string, InterruptionResolution> }
const RESOLUTION_INVALID = 'interruption-resolution-invalid'
export function invalidResolution(
  recordId: string | null,
  rule: string,
  message: string,
  detail: Json = {},
): Diagnostic {
  return {
    code: RESOLUTION_INVALID,
    message,
    ...(recordId === null ? {} : { recordId }),
    detail: { rule, ...(typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? detail : {}) },
  }
}
export function isInterruptionAction(action: string): action is InterruptionAction {
  return (INTERRUPTION_ACTIONS as readonly string[]).includes(action)
}

export function isInterruptionResolution(record: CanonicalRecord | null | undefined): record is ResolutionRecord {
  return record?.kind === 'operator-control' && record.payload.control === 'resolve-interruption'
}

export function interruptionResolutionRecordId(startRecordId: string): string {
  return `${INTERRUPTION_RESOLUTION_PREFIX}${startRecordId}`
}

export function interruptionResolutionDigest(proposal: ResolutionProposal): string {
  return canonicalValueDigest({ format: INTERRUPTION_RESOLUTION_FORMAT, ...proposal })
}

/** The only diagnostic that marks a RESULT as a host-observed interruption; the host writes it, never the model. */
export function hostInterruptionDiagnostic(origin: string): Diagnostic {
  return {
    code: 'action-interrupted',
    message: `Native execution interrupted (${origin})`,
    detail: { marker: HOST_INTERRUPTION_MARKER, proof: 'not-dispatched', origin },
  }
}

function hostInterruptionMarked(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((entry) => {
    const detail = entry.detail
    return (
      entry.code === 'action-interrupted' &&
      typeof detail === 'object' &&
      detail !== null &&
      !Array.isArray(detail) &&
      detail.marker === HOST_INTERRUPTION_MARKER &&
      detail.proof === 'not-dispatched' &&
      typeof detail.origin === 'string'
    )
  })
}

/** Only a host-proven pre-dispatch stop with no output or admitted effects is resolvable. */
export function interruptedResult(result: ReceiptRecord): boolean {
  const payload = result.payload
  if (payload.phase !== 'result' || !isInterruptionAction(payload.action)) return false
  if (workflowContextNegative(result)) return false
  if (
    payload.admission !== null &&
    (payload.admission.admitted ||
      payload.admission.commits.length > 0 ||
      payload.admission.paths.length > 0 ||
      payload.admission.commands.length > 0 ||
      payload.admission.remoteBranch !== null ||
      payload.admission.remoteTip !== null ||
      payload.admission.published)
  )
    return false
  return (
    payload.native.completion !== 'completed' &&
    payload.native.strict === 'absent' &&
    payload.structured === null &&
    hostInterruptionMarked(payload.diagnostics)
  )
}

/** The unique START/RESULT pair of a typed interrupted RESULT; native validity is deliberately not required. */
export function authenticateInterruptedReceiptPair(
  history: DecodedHistory,
  result: ReceiptRecord,
): Result<{ start: ReceiptRecord; result: ReceiptRecord }> {
  if (!interruptedResult(result)) return fail([diagnostic('unconfirmed', 'Receipt is not a typed interrupted RESULT')])
  return authenticateWorkflowReceiptPair(history, result, { native: 'unchecked' })
}
