import { canonicalValueDigest } from './action-input.ts'
import type { PinnedFileRef, RecordInputRef } from './action-input-schema.ts'
import type { CriterionEvidence, ObservationRef } from './criterion-evidence-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerSourceDiagnostics } from './observation-input-authentication.ts'
import { diagnostic } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>

export function nativeResultValid(record: Receipt): boolean {
  return (
    record.payload.phase === 'result' &&
    record.payload.native.completion === 'completed' &&
    record.payload.native.strict === 'valid'
  )
}

export function implementationReceiptEligible(record: Receipt): boolean {
  return (
    record.payload.format === 'omp-build-action-receipt/2' &&
    record.payload.action === 'implement' &&
    record.payload.phase === 'result' &&
    record.payload.admission?.admitted === true &&
    nativeResultValid(record)
  )
}

export function citedOperationIntegrity(history: DecodedHistory, recordId: string): Diagnostic | null {
  const matches = history.operations.filter(
    (operation) => operation.recordId === recordId || operation.record?.recordId === recordId,
  )
  const operation = matches[0]
  if (operation === undefined || operation.record === null) {
    return diagnostic('unconfirmed', `Record ${recordId} has no observed operation`)
  }
  if (
    operation.operationId !== operation.record.operationId ||
    operation.recordId !== operation.record.recordId ||
    operation.kind !== operation.record.kind
  ) {
    return diagnostic('unbound', `Observed operation metadata does not identify record ${recordId}`)
  }
  if (operation.parts.some((part) => part.nativeId === null || part.nativeId.length === 0)) {
    return diagnostic('unconfirmed', `Operation ${operation.operationId ?? recordId} lacks a native comment identity`)
  }
  const expected = history.source.expectedAuthor
  const stopAuthor = history.source.stopAuthor
  const authorized = (author: string | null) =>
    author === expected || (operation.record?.kind === 'stop' && stopAuthor !== null && author === stopAuthor)
  if (operation.parts.some((part) => !authorized(part.author))) {
    return diagnostic('unbound', `Operation ${operation.operationId ?? recordId} has an unauthorized native author`)
  }
  const integrity = recordIntegrity(operation.parts, operation.record)
  return integrity === null ? null : diagnostic(integrity.reason, integrity.detail)
}

function pinKey(pin: PinnedFileRef): string {
  return [pin.repository, pin.commit, pin.path, pin.digest].join('\0')
}

function pointer(value: unknown, selector: string): unknown {
  if (selector === '') return value
  let current = value
  for (const raw of selector.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key]
  }
  return current
}

export function observationRefDiagnostics(
  evidenceId: string,
  ref: ObservationRef,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
): Diagnostic[] {
  if (ref.source === 'git-file') {
    if (!new Set(pins.map(pinKey)).has(pinKey(ref))) {
      return [diagnostic('unknown-reference', `Evidence ${evidenceId} cites an unauthenticated pinned source`)]
    }
    return []
  }
  return recordRefDiagnostics(evidenceId, ref, histories)
}

function versionClaimReferences(evidence: CriterionEvidence): ObservationRef[] {
  if (evidence.method !== 'test') return []
  return [
    ...evidence.after.versionClaim.references,
    ...(evidence.before === null ? [] : evidence.before.versionClaim.references),
  ]
}
function nativeObservationMatches(evidence: Exclude<CriterionEvidence, { method: 'test' }>, receipt: Receipt): boolean {
  const payload = receipt.payload
  if (payload.action !== 'implement' || payload.phase !== 'result' || !implementationReceiptEligible(receipt))
    return false
  const provenance = evidence.provenance
  if (provenance.kind !== 'native') return false
  const observation = payload.native.observation
  if (
    observation === undefined ||
    provenance.actionId !== payload.actionId ||
    observation.actionId !== payload.actionId ||
    provenance.childId !== observation.childId ||
    provenance.submissionIndex !== observation.submissionIndex ||
    observation.submission.attemptIndex !== observation.submissionIndex ||
    provenance.toolCallIds.some((id) => !(payload.native.bashCalls ?? []).some((call) => call.toolCallId === id))
  )
    return false
  const raw = payload.native.raw
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const structured = raw.structuredOutput
  if (
    raw.id !== observation.childId ||
    structured === null ||
    typeof structured !== 'object' ||
    Array.isArray(structured) ||
    structured.status !== 'valid' ||
    structured.data === undefined ||
    canonicalValueDigest(structured.data) !== canonicalValueDigest(observation.submission.data)
  )
    return false
  const submissionRaw = observation.submission.raw
  if (
    submissionRaw === null ||
    typeof submissionRaw !== 'object' ||
    Array.isArray(submissionRaw) ||
    typeof submissionRaw.toolCallId !== 'string' ||
    submissionRaw.toolCallId.length === 0
  )
    return false
  const executed = submissionRaw.executionArguments
  if (
    executed === null ||
    typeof executed !== 'object' ||
    Array.isArray(executed) ||
    executed.data === undefined ||
    canonicalValueDigest(executed.data) !== canonicalValueDigest(observation.submission.data)
  )
    return false
  const data = observation.submission.data
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.criteria)) return false
  const { provenance: _provenance, ...producerEvidence } = evidence
  const digest = canonicalValueDigest(producerEvidence)
  return data.criteria.some(
    (declaration) =>
      declaration !== null &&
      typeof declaration === 'object' &&
      !Array.isArray(declaration) &&
      declaration.verification === 'evidence' &&
      Array.isArray(declaration.evidence) &&
      declaration.evidence.some((item) => canonicalValueDigest(item) === digest),
  )
}

function testRunsMatchHostCapture(evidence: Extract<CriterionEvidence, { method: 'test' }>, receipt: Receipt): boolean {
  const payload = receipt.payload
  if (
    payload.action !== 'implement' ||
    payload.phase !== 'result' ||
    !implementationReceiptEligible(receipt) ||
    evidence.provenance.kind !== 'native' ||
    evidence.provenance.actionId !== payload.actionId
  )
    return false
  const provenance = evidence.provenance
  const runs = [evidence.after.run, ...(evidence.before === null ? [] : [evidence.before.run])]
  const calls = payload.native.bashCalls ?? []
  return runs.every(
    (run) =>
      provenance.toolCallIds.includes(run.toolCallId) &&
      calls.some((call) => {
        const input = call.input
        return (
          call.toolCallId === run.toolCallId &&
          call.result !== null &&
          call.exitCode === run.exitCode &&
          input !== null &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          input.command === run.command
        )
      }),
  )
}

export function observationAuthenticationDiagnostics(
  evidence: CriterionEvidence,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
  receipt: Receipt,
): Diagnostic[] {
  const diagnostics = versionClaimReferences(evidence).flatMap((ref) =>
    observationRefDiagnostics(evidence.id, ref, histories, pins),
  )
  if (evidence.method === 'test') {
    if (!testRunsMatchHostCapture(evidence, receipt))
      diagnostics.push(diagnostic('unconfirmed', `Evidence ${evidence.id} test runs are not in the host capture`))
    return diagnostics
  }
  const knownPins = new Set(pins.map(pinKey))
  const refs = evidence.references
  diagnostics.push(...producerSourceDiagnostics(evidence.id, refs, receipt.payload.inputs))
  for (const ref of refs) {
    if (ref.source === 'git-file') {
      if (!knownPins.has(pinKey(ref))) {
        diagnostics.push(
          diagnostic('unknown-reference', `Evidence ${evidence.id} cites an unauthenticated pinned source`),
        )
      }
      continue
    }
    diagnostics.push(...recordRefDiagnostics(evidence.id, ref, histories))
  }
  if (evidence.provenance.kind === 'operator') {
    diagnostics.push(...recordSourceDiagnostics(evidence.id, evidence.provenance.source, histories))
  }
  if (evidence.provenance.kind === 'native' && !nativeObservationMatches(evidence, receipt)) {
    diagnostics.push(
      diagnostic('unconfirmed', `Evidence ${evidence.id} native provenance is not the admitted host observation`),
    )
  }
  return diagnostics
}

function recordSourceDiagnostics(
  evidenceId: string,
  ref: ExternalRecordRef,
  histories: readonly DecodedHistory[],
): Diagnostic[] {
  const history = historyFor(ref.scope, histories)
  if (history === null) return [diagnostic('missing-history', `Evidence ${evidenceId} has no history for its source`)]
  const bound = bindExternalRef(ref, history)
  if (!bound.ok) return [...bound.diagnostics]
  const integrity = citedOperationIntegrity(history, ref.recordId)
  return integrity === null ? [] : [integrity]
}

function recordRefDiagnostics(
  evidenceId: string,
  ref: RecordInputRef,
  histories: readonly DecodedHistory[],
): Diagnostic[] {
  const history = historyFor(ref.record.scope, histories)
  if (history === null)
    return [diagnostic('missing-history', `Evidence ${evidenceId} has no history for ${ref.record.recordId}`)]
  const bound = bindExternalRef(ref.record, history)
  if (!bound.ok) return [...bound.diagnostics]
  const integrity = citedOperationIntegrity(history, ref.record.recordId)
  if (integrity !== null) return [integrity]
  const selected = pointer(bound.value, ref.selector)
  if (selected === undefined || canonicalValueDigest(selected) !== ref.digest) {
    return [diagnostic('mismatch', `Evidence ${evidenceId} observation digest does not match ${ref.record.recordId}`)]
  }
  return []
}
