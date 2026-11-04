import { canonicalValueDigest } from './action-input.ts'
import { assessCauseDispositions, blockingLabels } from './cause-assessment.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>

function validateRetainedFinding(record: Disposition, source: CanonicalRecord, diagnostics: Diagnostic[]): void {
  const payload = record.payload
  const subject = payload.subject
  if (subject.kind !== 'retained-finding') return
  const original =
    source.kind === 'contribution' && source.payload.findings?.find((finding) => finding.id === subject.finding.id)
  if (!original || canonicalValueDigest(original) !== canonicalValueDigest(subject.finding))
    diagnostics.push(diagnostic('cause-source-mismatch', `Retained finding ${record.recordId} differs from its source`))
  const inspection = inspectFinding(subject.finding.data, [])
  const blocking = inspection.knownLabel === null || blockingLabels.has(inspection.knownLabel)
  if (
    (blocking && payload.outcome.state !== 'pending-blocking') ||
    (!blocking &&
      (payload.outcome.state !== 'final' || payload.outcome.disposition !== 'report' || payload.outcome.blocking))
  )
    diagnostics.push(diagnostic('cause-outcome-mismatch', `Retained finding ${record.recordId} has an invalid outcome`))
}

function validateRetained(record: Disposition, histories: readonly DecodedHistory[], diagnostics: Diagnostic[]): void {
  const payload = record.payload
  if (payload.subject.kind === 'cause') return
  const ref = payload.subject.kind === 'retained-finding' ? payload.subject.contribution : payload.subject.source
  const history = histories.find((item) => equalScope(item.source.scope, ref.scope))
  const source = history && bindExternalRef(ref, history)
  if (!source?.ok)
    diagnostics.push(
      diagnostic('cause-source-unconfirmed', `Retained disposition ${record.recordId} lacks its authenticated source`),
    )
  else if (payload.subject.kind === 'retained-finding') validateRetainedFinding(record, source.value, diagnostics)
  else if (payload.outcome.state !== 'pending-blocking')
    diagnostics.push(diagnostic('cause-outcome-mismatch', `Rule error ${record.recordId} must remain pending`))
}

function validateCause(
  record: Disposition,
  operations: readonly Operation[],
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): void {
  const payload = record.payload
  if (payload.subject.kind !== 'cause') return
  const ref = payload.subject.decision
  const sourceHistory = histories.find((history) => equalScope(history.source.scope, ref.scope))
  const source = sourceHistory && bindExternalRef(ref, sourceHistory)
  const originHistory = histories.find((history) => equalScope(history.source.scope, payload.origin.uw))
  if (!source?.ok || source.value.kind !== 'decision' || !originHistory) {
    diagnostics.push(
      diagnostic('cause-source-unconfirmed', `Disposition ${record.recordId} lacks its authenticated source histories`),
    )
    return
  }
  const effective = recordsOf(originHistory).flatMap((candidate) => {
    if (candidate.kind !== 'mandate') return []
    const accepted = resolveAcceptedSpec(candidate, histories)
    if (!accepted.ok || !sameOwnSpecRef(accepted.spec.ref, payload.origin)) return []
    const projection = resolveOwnSpecEffective(accepted.spec)
    return projection.ok ? [projection.value] : []
  })
  if (effective.length !== 1 || effective[0] === undefined) {
    diagnostics.push(
      diagnostic('cause-origin-unconfirmed', `Disposition ${record.recordId} lacks a unique accepted Spec`),
    )
    return
  }
  const adjudicationRef = payload.adjudication
  const adjudications =
    adjudicationRef === null
      ? []
      : operations.filter(
          (item) => item.recordId === adjudicationRef.recordId && equalScope(item, adjudicationRef.scope),
        )
  const assessed = assessCauseDispositions({
    context: { original: payload.origin.uw, effective: effective[0] },
    source: { kind: 'decision', decision: source.value },
    histories,
    adjudications,
  })
  if (!assessed.ok) diagnostics.push(...assessed.diagnostics)
  else if (!assessed.value.outcomes.some((outcome) => canonicalValueDigest(outcome) === canonicalValueDigest(payload)))
    diagnostics.push(
      diagnostic(
        'cause-outcome-mismatch',
        `Disposition ${record.recordId} differs from authenticated mechanical assessment`,
      ),
    )
}

export function validateCauseSubject(
  record: Disposition,
  operations: readonly Operation[],
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): void {
  validateRetained(record, histories, diagnostics)
  validateCause(record, operations, histories, diagnostics)
}
