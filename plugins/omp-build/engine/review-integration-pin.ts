import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs, ActionSpecInput, ActionSubject, RecordInputRef } from './action-input-schema.ts'
import { integrationReceiptEligible } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { hasIntegrationReviewPin } from './review-subject-binding.ts'
import { type IntegrationOutput, integrationOutputSchema } from './uw-integration-schema.ts'
import { bindExternalRef, historyFor, recordsOf } from './workflow-control.ts'
import { resolveManifestMandate } from './workflow-pr-binding.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

function integrationCodeMatchesProducer(
  producer: ActionInputs['manifest']['code'],
  produced: IntegrationOutput['code'],
  remoteTip: string | null | undefined,
): boolean {
  return (
    producer.referenceCommit === producer.head &&
    produced.referenceCommit === producer.referenceCommit &&
    produced.repository === producer.repository &&
    produced.base === producer.base &&
    remoteTip === produced.head
  )
}

function integrationVersionMatchesReview(inputs: ActionInputs, subject: ActionSubject, spec: ActionSpecInput): boolean {
  const integratedSubject = inputs.manifest.subject
  return (
    validateActionInputs(inputs).ok &&
    integratedSubject.kind === 'uw' &&
    canonicalValueDigest(integratedSubject) === canonicalValueDigest(subject) &&
    inputs.manifest.spec.kind === 'accepted' &&
    canonicalValueDigest(inputs.manifest.spec) === canonicalValueDigest(spec)
  )
}

function authenticateIntegrationStart(
  payload: Extract<ActionReceiptPayload, { action: 'integrate'; phase: 'result' }>,
  pin: RecordInputRef,
  history: DecodedHistory,
): Result<void> {
  const invalid = (message: string): Result<never> => fail([diagnostic('integration-start-unpaired', message)])
  if (payload.start.kind !== 'action-receipt' || !equalScope(payload.start.scope, pin.record.scope))
    return invalid('Integration start must be in the selected result history')
  const matching = recordsOf(history).filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'integrate' &&
      record.payload.actionId === payload.actionId,
  )
  if (
    matching.filter((record) => record.kind === 'action-receipt' && record.payload.phase === 'start').length !== 1 ||
    matching.filter((record) => record.kind === 'action-receipt' && record.payload.phase === 'result').length !== 1
  )
    return invalid('Integration action must have one start and one result')
  const start = bindExternalRef(payload.start, history)
  if (!start.ok) return start
  if (
    start.value.kind !== 'action-receipt' ||
    start.value.payload.action !== 'integrate' ||
    start.value.payload.phase !== 'start' ||
    start.value.payload.actionId !== payload.actionId ||
    !sameRef(start.value.payload.mandate, payload.mandate) ||
    canonicalValueDigest(start.value.payload.inputs) !== canonicalValueDigest(payload.inputs) ||
    canonicalValueDigest(start.value.payload.exactInputs) !== canonicalValueDigest(payload.exactInputs)
  )
    return invalid('Integration result does not bind its exact authenticated start and complete inputs')
  return { ok: true, value: undefined }
}

/** Authenticate the selected admitted integration and its exact producer chain. */
export function authenticateIntegrationPin(
  pin: RecordInputRef,
  expected: { subject: ActionSubject; spec: ActionSpecInput; mandate: ExternalRecordRef },
  histories: readonly DecodedHistory[],
): Result<{ source: ExternalRecordRef; output: IntegrationOutput }> {
  const invalid = (code: string, message: string): Result<never> => fail([diagnostic(code, message)])
  const { subject, spec, mandate } = expected
  if (
    pin.source !== 'record' ||
    pin.selector !== '/payload/structured/code' ||
    subject.kind !== 'uw' ||
    subject.pullRequest !== null ||
    subject.binding !== null ||
    spec.kind !== 'accepted'
  )
    return invalid('integration-pin-unbound', 'Integration must select an accepted parent UW code receipt')
  const history = historyFor(pin.record.scope, histories)
  if (history === null) return invalid('integration-history-missing', 'Selected integration history is unavailable')
  const bound = bindExternalRef(pin.record, history)
  if (!bound.ok) return bound
  if (bound.value.kind !== 'action-receipt' || !integrationReceiptEligible(bound.value))
    return invalid('integration-result-unconfirmed', 'Selected integration receipt is not a native admitted result')
  const receipt = bound.value
  const payload = receipt.payload
  if (payload.action !== 'integrate' || payload.phase !== 'result')
    return invalid('integration-result-unconfirmed', 'Selected receipt is not an integration result')
  const output = integrationOutputSchema.safeParse(payload.structured)
  if (!output.success || pin.digest !== canonicalValueDigest(output.data.code))
    return invalid('integration-code-unbound', 'Selected integration code digest does not match the receipt')
  if (!integrationCodeMatchesProducer(payload.inputs.manifest.code, output.data.code, payload.admission?.remoteTip))
    return invalid(
      'integration-code-mismatch',
      'Integration code range or action-specific reference commit does not match its producer',
    )
  if (!integrationVersionMatchesReview(payload.inputs, subject, spec))
    return invalid(
      'integration-version-mismatch',
      'Integration and review do not bind the same accepted UW and full version vector',
    )
  if (!sameRef(payload.mandate, mandate))
    return invalid('integration-mandate-mismatch', 'Integration and review do not bind the same execution mandate')
  const start = authenticateIntegrationStart(payload, pin, history)
  if (!start.ok) return start
  return { ok: true, value: { source: pin.record, output: output.data } }
}

/** A final review additionally binds the physical range and its own head reference. */
export function authenticateReviewIntegrationPin(
  inputs: ActionInputs,
  histories: readonly DecodedHistory[],
): Result<{ source: ExternalRecordRef; output: IntegrationOutput }> {
  const invalid = (code: string, message: string): Result<never> => fail([diagnostic(code, message)])
  if (!validateActionInputs(inputs).ok || !hasIntegrationReviewPin(inputs))
    return invalid('integration-pin-unbound', 'Final range review must select exactly one integration code receipt')
  const subject = inputs.manifest.subject
  const spec = inputs.manifest.spec
  if (
    inputs.manifest.purpose !== 'review' ||
    subject.kind !== 'uw' ||
    subject.pullRequest !== null ||
    subject.binding !== null ||
    spec.kind !== 'accepted'
  )
    return invalid('integration-review-unbound', 'Final integration review must bind an accepted parent UW')
  const mandate = resolveManifestMandate(inputs, histories)
  if (!mandate.ok) return mandate
  const pin = inputs.manifest.deliveryData.find((item) => item.role === 'integration')
  if (pin === undefined)
    return invalid('integration-pin-unbound', 'Final range review must select exactly one integration code receipt')
  const authenticated = authenticateIntegrationPin(
    pin,
    {
      subject,
      spec,
      mandate: {
        scope: { repository: mandate.value.repository, target: mandate.value.target },
        kind: 'mandate',
        recordId: mandate.value.recordId,
      },
    },
    histories,
  )
  if (!authenticated.ok) return authenticated
  const produced = authenticated.value.output.code
  const reviewed = inputs.manifest.code
  if (
    reviewed.referenceCommit !== reviewed.head ||
    produced.repository !== reviewed.repository ||
    produced.base !== reviewed.base ||
    produced.head !== reviewed.head
  )
    return fail([
      diagnostic(
        'integration-code-mismatch',
        'Integration and review code ranges or action-specific reference commits do not match',
      ),
    ])
  return authenticated
}
