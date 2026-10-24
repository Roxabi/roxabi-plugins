import { requiredSlotsComplete } from './history-conservation.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import {
  type Contribution,
  type Diagnostic,
  findingSchema,
  type Json,
  type RecallClass,
  type RecallPlan,
} from './record-values.ts'
import type { Result } from './result.ts'

type OriginalEntry = { id: string; data: Json; contribution: Contribution }
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
      entries.push({ id: original.id, data: original.data, contribution: record.payload })
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
  if (entry.contribution.host.chunk !== null) indexed.chunks.add(entry.contribution.host.chunk)
  for (const callsite of callsites) indexed.callsites.set(`${callsite.file}:${callsite.line}`, callsite)
  indexed.sourceFindingIds.add(entry.id)
  classes.set(classId, indexed)
}

function recallClasses(
  entries: readonly OriginalEntry[],
  canonicalClasses: readonly string[],
): Map<string, IndexedClass> {
  const classes = new Map<string, IndexedClass>()
  for (const entry of entries) {
    const inspected = inspectFinding(entry.data, canonicalClasses)
    if (!inspected.usable) continue
    const finding = findingSchema.parse(entry.data)
    for (const classId of finding.classes ?? []) {
      if (!canonicalClasses.includes(classId) || classId.startsWith('candidate/')) continue
      indexRecallClass(classes, classId, entry, finding.rawCallsites ?? [])
    }
  }
  return classes
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
  canonicalClasses: readonly string[],
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
  const index = recallIndex(recallClasses(originalEntriesForRoot(records, rootAttemptId), canonicalClasses))
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
