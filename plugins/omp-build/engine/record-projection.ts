import { classifyHistory } from './history-classification.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import { projectionClosure } from './record-projection-closure.ts'
import { type ExternalRecordRef, isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { type RecordProjectionConfig, type Result, recordMap } from './result.ts'
import { validateDecision } from './review-decision.ts'
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
  const matches = foreign.operations.filter(
    (operation) => operation.record?.recordId === ref.recordId || operation.recordId === ref.recordId,
  )
  if (matches.length === 0) return diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)
  if (matches.some((operation) => operation.status === 'conflict'))
    return diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)
  if (
    matches.some(
      (operation) => operation.status !== 'complete' || operation.record === null || operation.authority === 'foreign',
    )
  )
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
  const records = recordMap(history)
  const home = records.get(record.recordId)
  if (home !== undefined && JSON.stringify(home) !== JSON.stringify(record))
    return fail([
      diagnostic('conflict', `Record ${record.recordId} conflicts with the complete record already in this history`),
    ])
  if (
    history.operations.some(
      (operation) => operation.record?.recordId === record.recordId && operation.authority === 'foreign',
    )
  )
    return fail([diagnostic('foreign', `Record ${record.recordId} is not from the expected author`)])
  const referenceDiagnostic = workflowReferenceDiagnostic(record, records, externalHistories)
  if (referenceDiagnostic !== null) return fail([referenceDiagnostic])
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
  const assessment = validateDecision(decision, history, config.taxonomy, config.acceptedPolicy)
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

export function projectRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Result<string> {
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
  if (record.kind === 'review') return projectReviewRecord(record, projectionHistory, records, config)
  if (record.kind === 'contribution' && record.payload.host.origin === 'operator')
    return projectOperatorContribution(record)
  return {
    ok: true,
    value: `# OMP build record\n\n- Kind: ${record.kind}\n- Record: ${record.recordId}\n- Operation: ${record.operationId}\n\n\`\`\`json\n${stringified(record.payload)}\n\`\`\``,
  }
}
