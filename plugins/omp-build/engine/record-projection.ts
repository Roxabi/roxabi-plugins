import { validateCauseDispositionRecords } from './cause-disposition.ts'
import { classifyHistory } from './history-classification.ts'
import { validateProspectiveRecord, validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import { projectionClosure } from './record-projection-closure.ts'
import { type ExternalRecordRef, isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { type RecordProjectionConfig, type Result, recordMap } from './result.ts'
import { validateFreshDecision } from './review-decision.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'
import { scopedRefsOf, workflowInputMeaning } from './workflow-record-references.ts'

function stringified(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null'
}

function externalReferenceDiagnostic(
  ref: ExternalRecordRef,
  externalHistories: readonly DecodedHistory[],
): Diagnostic | null {
  const foreign = externalHistories.find((item) => equalScope(item.source.scope, ref.scope))
  if (foreign === undefined)
    return diagnostic('missing-history', `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`)
  if (!foreign.source.complete) return diagnostic('incomplete', 'External history pagination is incomplete')
  const observations = foreign.operations.filter(
    (operation) => operation.record?.recordId === ref.recordId || operation.recordId === ref.recordId,
  )
  if (observations.length === 0) return diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)
  const matches = observations.filter((operation) => operation.authority !== 'foreign')
  if (matches.length === 0)
    return diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)
  if (matches.some((operation) => operation.status === 'conflict'))
    return diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)
  if (matches.some((operation) => operation.status !== 'complete' || operation.record === null))
    return diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)
  const bodies = new Set(matches.map((operation) => JSON.stringify(operation.record)))
  if (bodies.size !== 1) return diagnostic('ambiguous', `Record ${ref.recordId} has incompatible duplicates`)
  return matches[0]?.record?.kind !== ref.kind
    ? diagnostic('kind-mismatch', `Record ${ref.recordId} kind does not match the reference`)
    : null
}

function workflowReferenceDiagnostic(
  record: CanonicalRecord,
  records: ReadonlyMap<string, CanonicalRecord>,
  externalHistories: readonly DecodedHistory[],
): Diagnostic | null {
  for (const ref of scopedRefsOf(record)) {
    if (equalScope(ref.scope, { repository: record.repository, target: record.target })) {
      const found = records.get(ref.recordId)
      if (found === undefined)
        return diagnostic('unknown-reference', `Record ${record.recordId} lacks same-scope input ${ref.recordId}`)
      if (found.kind !== ref.kind)
        return diagnostic('kind-mismatch', `Record ${ref.recordId} is ${found.kind}, not ${ref.kind}`)
      continue
    }
    const externalDiagnostic = externalReferenceDiagnostic(ref, externalHistories)
    if (externalDiagnostic !== null) return externalDiagnostic
  }
  return null
}

function projectWorkflowRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
): Result<string> {
  const meaning = workflowInputMeaning(record)
  if (meaning !== null) return fail([meaning])
  if (!history.source.complete || !equalScope(record, history.source.scope))
    return fail([
      diagnostic('unbound', `Record ${record.recordId} cannot be projected outside a complete bound history`),
    ])
  const records = recordMap({
    ...history,
    operations: history.operations.filter((operation) => operation.authority !== 'foreign'),
  })
  const home = records.get(record.recordId)
  if (home !== undefined && JSON.stringify(home) !== JSON.stringify(record))
    return fail([
      diagnostic('conflict', `Record ${record.recordId} conflicts with the complete record already in this history`),
    ])
  const referenceDiagnostic = workflowReferenceDiagnostic(record, records, externalHistories)
  if (referenceDiagnostic !== null) return fail([referenceDiagnostic])
  if (record.kind === 'cause-disposition' || record.kind === 'cause-operation' || record.kind === 'report-promotion') {
    const candidates = [...records.values()].filter((item) => item.recordId !== record.recordId)
    const diagnostics = validateCauseDispositionRecords({
      records: [...candidates, record],
      histories: [history, ...externalHistories],
    })
    if (diagnostics.length) return fail(diagnostics)
  }
  return {
    ok: true,
    value: `# OMP build record\n\n- Kind: ${record.kind}\n- Record: ${record.recordId}\n- Operation: ${record.operationId}\n\n\`\`\`json\n${stringified(record.payload)}\n\`\`\``,
  }
}

function projectReviewRecord(
  record: Extract<CanonicalRecord, { kind: 'review' }>,
  history: DecodedHistory,
  records: ReadonlyMap<string, CanonicalRecord>,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
): Result<string> {
  const decision = records.get(record.payload.decisionId)
  if (decision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${record.recordId} lacks its decision`)])
  if (
    config === null ||
    typeof config !== 'object' ||
    !Array.isArray(Reflect.get(config, 'taxonomy')) ||
    Reflect.get(config, 'taxonomy').some((classId: unknown) => typeof classId !== 'string') ||
    (Reflect.get(config, 'acceptedPolicy') !== null && typeof Reflect.get(config, 'acceptedPolicy') !== 'string')
  )
    return fail([diagnostic('unbound', `Review ${record.recordId} has no valid projection policy context`)])
  const fresh = validateFreshDecision(
    decision,
    history,
    config.taxonomy,
    config.acceptedPolicy,
    externalHistories,
    deliveryHistory,
    record.payload.causeDispositionRefs,
  )
  if (!fresh.ok) return fail(fresh.diagnostics)
  const assessment = fresh.value
  if (!assessment.admissible || assessment.verdict === null)
    return fail(
      assessment.diagnostics.length > 0
        ? assessment.diagnostics
        : [diagnostic('unusable-finding', 'Review decision is not admissible')],
    )
  const provenance = decision.payload.judgment.sourceContributionIds.map((sourceId) => {
    const source = records.get(sourceId)
    return source?.kind === 'contribution'
      ? { contributionId: sourceId, host: source.payload.host, originals: source.payload.findings }
      : { contributionId: sourceId }
  })
  const standards = decision.payload.judgment.purpose === 'review' ? decision.payload.judgment.standards : null
  const standardsDisplay =
    standards === null
      ? 'smells: unavailable'
      : standards.state === 'ras'
        ? 'smells: RAS'
        : standards.rows.map((row) => `- possible ${row.smell}: ${row.assessment}`).join('\n')
  return {
    ok: true,
    value: `# OMP build review\n\n**Verdict: ${assessment.verdict}**\n\n- Record: ${record.recordId}\n- Decision: ${record.payload.decisionId}\n- Candidate: ${record.payload.candidateGitSHA}\n- Input: ${record.payload.input ?? 'none'}\n\n## Findings\n\n${stringified(decision.payload.judgment.findings)}\n\n## Standards\n\n${standardsDisplay}\n\n## Source provenance\n\n${stringified(provenance)}`,
  }
}

function projectOperatorContribution(record: Extract<CanonicalRecord, { kind: 'contribution' }>): Result<string> {
  const native =
    record.payload.native === null
      ? null
      : { completion: record.payload.native.completion, strict: record.payload.native.strict }
  return {
    ok: true,
    value: `# OMP build contribution\n\n- Canonical frame record: ${record.recordId}\n- Canonical frame operation: ${record.operationId}\n\n\`\`\`json\n${stringified({ ...record.payload, native })}\n\`\`\``,
  }
}

function matchesCorrectionDisposition(
  record: Extract<CanonicalRecord, { kind: 'correction-result' }>,
  source: CanonicalRecord,
): boolean {
  return (
    source.kind === 'cause-disposition' &&
    source.payload.subject.kind === 'cause' &&
    source.payload.subject.decision.recordId === record.payload.decisionId &&
    equalScope(source.payload.subject.decision.scope, record) &&
    source.payload.subject.cause.id === record.payload.causeId &&
    source.payload.outcome.state === 'final' &&
    source.payload.outcome.disposition === 'fix-original'
  )
}

function correctionReferenceDiagnostics(
  record: Extract<CanonicalRecord, { kind: 'fix-request' | 'correction-result' | 'fix-result' }>,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
): Diagnostic[] | null {
  for (const ref of scopedRefsOf(record)) {
    const sourceHistory = [history, ...externalHistories].find((item) => equalScope(item.source.scope, ref.scope))
    if (!sourceHistory) return [diagnostic('missing-history', `No history supplied for ${ref.recordId}`)]
    const source = bindExternalRef(ref, sourceHistory)
    if (!source.ok) return source.diagnostics
    if (record.kind === 'correction-result' && !matchesCorrectionDisposition(record, source.value))
      return [
        diagnostic('cause-effect-mismatch', `Correction ${record.recordId} does not match an admitted fix disposition`),
      ]
  }
  return null
}

function projectionReferenceDiagnostics(
  record: CanonicalRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
): Diagnostic[] | null {
  if (record.kind === 'debt-receipt') {
    const candidates = recordsOf(history).filter((item) => item.recordId !== record.recordId)
    const diagnostics = validateCauseDispositionRecords({
      records: [...candidates, record],
      histories: [history, ...externalHistories],
    })
    if (diagnostics.length) return diagnostics
  }
  if (record.kind === 'fix-request' || record.kind === 'correction-result' || record.kind === 'fix-result')
    return correctionReferenceDiagnostics(record, history, externalHistories)
  return null
}

export function projectRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Result<string> {
  const prospective = validateProspectiveRecord(record, history)
  if (prospective.length > 0) return fail(prospective)
  if (isWorkflowKind(record.kind)) return projectWorkflowRecord(record, history, externalHistories)
  const closure = projectionClosure(record, history, classifyHistory(history))
  if (!closure.ok) return fail(closure.diagnostics)
  const projectionHistory = closure.value
  const graph = validateRecordGraph(projectionHistory)
  if (!graph.ok) return fail(graph.diagnostics)
  if (!projectionHistory.source.complete || !equalScope(record, projectionHistory.source.scope))
    return fail([
      diagnostic('unbound', `Record ${record.recordId} cannot be projected outside a complete bound history`),
    ])
  const records = new Map(graph.value.map((entry) => [entry.recordId, entry]))
  const referenceDiagnostics = projectionReferenceDiagnostics(record, history, externalHistories)
  if (referenceDiagnostics !== null) return fail(referenceDiagnostics)
  if (record.kind === 'review')
    return projectReviewRecord(record, projectionHistory, records, config, externalHistories, history)
  if (record.kind === 'contribution' && record.payload.host.origin === 'operator')
    return projectOperatorContribution(record)
  return {
    ok: true,
    value: `# OMP build record\n\n- Kind: ${record.kind}\n- Record: ${record.recordId}\n- Operation: ${record.operationId}\n\n\`\`\`json\n${stringified(record.payload)}\n\`\`\``,
  }
}
