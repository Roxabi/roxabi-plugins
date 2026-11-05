import { requiredSlotsComplete } from './history-conservation.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { type Diagnostic, findingSchema, type Json, type RecallClass, type RecallPlan } from './record-values.ts'
import type { Result } from './result.ts'
import { catalogueForAction, type ReviewClassCatalogues } from './review-class-catalogue.ts'
import { inspectContributionFindings, originalContributionAction } from './review-original-action.ts'

type OriginalEntry = { id: string; data: Json; contribution: Extract<CanonicalRecord, { kind: 'contribution' }> }
type IndexedClass = {
  chunks: Set<number>
  callsites: Map<string, { file: string; line: number }>
  sourceFindingIds: Set<string>
}

function originalEntriesForRoot(records: ReadonlyMap<string, CanonicalRecord>, rootAttemptId: string): OriginalEntry[] {
  const entries: OriginalEntry[] = []
  for (const record of records.values()) {
    if (
      record.kind !== 'contribution' ||
      record.payload.content !== 'findings' ||
      record.payload.host.phase !== 'panel' ||
      record.payload.inventoryId === null ||
      record.payload.findings === null
    )
      continue
    const inventory = records.get(record.payload.inventoryId)
    if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== rootAttemptId) continue
    for (const original of record.payload.findings)
      entries.push({ id: original.id, data: original.data, contribution: record })
  }
  return entries
}

function indexRecallClass(
  classes: Map<string, IndexedClass>,
  classId: string,
  entry: OriginalEntry,
  callsites: readonly { file: string; line: number }[],
): void {
  const indexed = classes.get(classId) ?? {
    chunks: new Set<number>(),
    callsites: new Map(),
    sourceFindingIds: new Set<string>(),
  }
  if (entry.contribution.payload.host.chunk !== null) indexed.chunks.add(entry.contribution.payload.host.chunk)
  for (const callsite of callsites) indexed.callsites.set(`${callsite.file}:${callsite.line}`, callsite)
  indexed.sourceFindingIds.add(entry.id)
  classes.set(classId, indexed)
}

function inspectRecallContribution(
  contribution: OriginalEntry['contribution'],
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): Result<ReturnType<typeof inspectContributionFindings>> {
  const action = originalContributionAction(contribution, history)
  if (!action.ok) return action
  const catalogue = catalogueForAction(action.value, catalogues)
  if (!catalogue.ok) return catalogue
  return { ok: true, value: inspectContributionFindings(contribution, history, catalogues) }
}

function recallClasses(
  entries: readonly OriginalEntry[],
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): Result<Map<string, IndexedClass>> {
  const classes = new Map<string, IndexedClass>()
  const inspected = new Map<string, ReturnType<typeof inspectContributionFindings>>()
  for (const entry of entries) {
    let findings = inspected.get(entry.contribution.recordId)
    if (findings === undefined) {
      const result = inspectRecallContribution(entry.contribution, history, catalogues)
      if (!result.ok) return result
      findings = result.value
      inspected.set(entry.contribution.recordId, findings)
    }
    if (!findings.get(entry.id)?.usable) continue
    const finding = findingSchema.parse(entry.data)
    for (const classId of finding.classes ?? []) {
      if (classId.startsWith('candidate/')) continue
      indexRecallClass(classes, classId, entry, finding.rawCallsites ?? [])
    }
  }
  return { ok: true, value: classes }
}

function recallIndex(classes: ReadonlyMap<string, IndexedClass>): RecallClass[] {
  return [...classes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([classId, value]) => ({
      classId,
      chunks: [...value.chunks].sort((left, right) => left - right),
      callsites: [...value.callsites.values()].sort(
        (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
      ),
      sourceFindingIds: [...value.sourceFindingIds].sort(),
    }))
}

export function deriveRecallPlan(
  history: DecodedHistory,
  rootAttemptId: string,
  catalogues: ReviewClassCatalogues,
): Result<RecallPlan> {
  const graph = validateRecordGraph(history)
  if (!graph.ok) return fail(graph.diagnostics)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const root = records.get(rootAttemptId)
  if (root?.kind !== 'review-attempt' || root.payload.stage !== 'initial' || root.payload.purpose !== 'review')
    return fail([diagnostic('unknown-reference', `Recall root ${rootAttemptId} is not an initial review inventory`)])
  const closureDiagnostics: Diagnostic[] = []
  requiredSlotsComplete(records, root, closureDiagnostics, true)
  if (closureDiagnostics.length > 0) return fail(closureDiagnostics)
  const classes = recallClasses(originalEntriesForRoot(records, rootAttemptId), history, catalogues)
  if (!classes.ok) return classes
  const index = recallIndex(classes.value)
  return {
    ok: true,
    value: {
      index,
      triggeredClassIds: index
        .filter((entry) => entry.chunks.length >= 2 && entry.callsites.length >= 3)
        .map((entry) => entry.classId),
      diagnostics: [],
    },
  }
}
