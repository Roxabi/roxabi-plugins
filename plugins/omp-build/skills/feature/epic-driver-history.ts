import {
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  type Json,
  validateDecision,
  validateRecordGraph,
} from '../../dist/contracts.js'
import type { UwAdmission } from '../../engine/uw-admission.ts'
import { loadReviewConfig } from '../../roxabi/review-assets.ts'
import { diagnosticsText } from './epic-driver-github'
import { Refused } from './epic-driver-runtime'
import { parseEpicEvent } from './epic-events'
import type { ChildFacts, Facts } from './epic-types'

export type EpicEvent = { record: Extract<CanonicalRecord, { kind: 'epic-event' }>; payload: Record<string, Json> }
export type Gathered = { facts: Facts; epicHistory: DecodedHistory; parentAdmission: UwAdmission }

function assertAdmissibleHistory(
  history: DecodedHistory,
  diagnostics: readonly { code: string; message: string }[],
): void {
  if (diagnostics.length > 0) {
    throw new Refused(`${history.source.scope.target} history is not admissible: ${diagnosticsText(diagnostics)}`)
  }
}

function objectPayload(payload: Json): payload is Record<string, Json> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
}

function epicEventAt(history: DecodedHistory, index: number, authority: string): EpicEvent | null {
  const operation = history.operations[index]
  if (operation === undefined)
    throw new Refused(`${history.source.scope.target} authority attribution is out of bounds`)
  if (authority === 'foreign' || operation.kind !== 'epic-event') return null
  if (authority !== 'accounted') {
    throw new Refused(`Epic event ${operation.operationId ?? 'unknown operation'} has ambiguous native authority`)
  }
  if (operation.status !== 'complete' || operation.record?.kind !== 'epic-event') {
    throw new Refused(
      `${history.source.scope.target} has ${operation.status} Epic event history (${operation.operationId ?? 'unknown operation'})`,
    )
  }
  const payload = operation.record.payload
  if (!objectPayload(payload) || parseEpicEvent(payload) === null) {
    throw new Refused(`Epic event ${operation.record.recordId} has an invalid domain payload`)
  }
  return { record: operation.record, payload }
}

export function epicEvents(history: DecodedHistory): EpicEvent[] {
  const classified = classifyHistory(history)
  assertAdmissibleHistory(history, classified.authorityHistory.diagnostics)
  return classified.classes.flatMap(({ index, authority }) => {
    const event = epicEventAt(history, index, authority)
    return event === null ? [] : [event]
  })
}

export function eventText(payload: Record<string, Json>, field: string): string | null {
  const value = payload[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function eventTextArray(payload: Record<string, Json>, field: string): string[] | null {
  const value = payload[field]
  if (!Array.isArray(value)) return null
  const strings: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) return null
    strings.push(entry)
  }
  return strings
}

export function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  )
}

type ReviewReferences = { run: string; range: string; decisionId: string; inventoryIds: string[] }
type DecisionRecord = Extract<CanonicalRecord, { kind: 'decision' }>
type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function reviewReferences({ record, payload }: EpicEvent): ReviewReferences {
  const run = eventText(payload, 'run')
  const range = eventText(payload, 'range')
  const decisionId = eventText(payload, 'decisionId')
  const inventoryIds = eventTextArray(payload, 'inventoryIds')
  if (run === null || range === null || decisionId === null || inventoryIds === null || record.runId !== run) {
    throw new Refused(`Epic review event ${record.recordId} has malformed references`)
  }
  return { run, range, decisionId, inventoryIds }
}

function reviewDecision(records: Map<string, CanonicalRecord>, event: EpicEvent, decisionId: string): DecisionRecord {
  const decision = records.get(decisionId)
  if (decision?.kind !== 'decision') {
    throw new Refused(`Epic review event ${event.record.recordId} names no decision ${decisionId}`)
  }
  return decision
}

function reviewRoot(
  records: Map<string, CanonicalRecord>,
  event: EpicEvent,
  decision: DecisionRecord,
  range: string,
): ReviewAttempt {
  const synthesis = records.get(decision.payload.originalContributionId)
  if (synthesis?.kind !== 'contribution' || synthesis.payload.inventoryId === null) {
    throw new Refused(`Epic review event ${event.record.recordId} decision is not bound to a synthesis inventory`)
  }
  const inventory = records.get(synthesis.payload.inventoryId)
  const root = inventory?.kind === 'review-attempt' ? records.get(inventory.payload.rootAttemptId) : null
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.subject.kind !== 'epic-range' ||
    root.payload.subject.range !== range
  ) {
    throw new Refused(`Epic review event ${event.record.recordId} does not bind the exact Epic range`)
  }
  return root
}

function assertExactInventories(
  records: Map<string, CanonicalRecord>,
  event: EpicEvent,
  decisionId: string,
  inventoryIds: readonly string[],
  root: ReviewAttempt,
): void {
  const expected = [...records.values()]
    .filter(
      (candidate): candidate is ReviewAttempt =>
        candidate.kind === 'review-attempt' && candidate.payload.rootAttemptId === root.recordId,
    )
    .map((inventory) => inventory.recordId)
  if (!sameReferences(inventoryIds, expected) || !sameReferences(event.record.inputs, [decisionId, ...inventoryIds])) {
    throw new Refused(`Epic review event ${event.record.recordId} does not bind its exact decision inventories`)
  }
}

/**
 * An Epic review event points to the canonical decision graph. Its disposition
 * is derived only after the exact range, synthesis root and full inventory set
 * are independently bound through the common record core.
 */
export function reviewsFromEvents(history: DecodedHistory): Facts['reviews'] {
  const events = epicEvents(history).filter(({ payload }) => payload.event === 'epic-review')
  if (events.length === 0) return []
  const authorityHistory = classifyHistory(history).authorityHistory
  const graph = validateRecordGraph(authorityHistory)
  if (!graph.ok) throw new Refused(`Epic review history is not admissible: ${diagnosticsText(graph.diagnostics)}`)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const taxonomy = loadReviewConfig().canonicalClasses
  const reviews: Facts['reviews'] = []
  for (const event of events) {
    const { run, range, decisionId, inventoryIds } = reviewReferences(event)
    const decision = reviewDecision(records, event, decisionId)
    const root = reviewRoot(records, event, decision, range)
    assertExactInventories(records, event, decisionId, inventoryIds, root)
    const assessment = validateDecision(decision, authorityHistory, taxonomy, null)
    if (!assessment.admissible || assessment.verdict === null) {
      throw new Refused(
        `Epic review event ${event.record.recordId} decision is not admissible: ${diagnosticsText(assessment.diagnostics)}`,
      )
    }
    reviews.push({ run, range, verdict: assessment.verdict === 'Request changes' ? 'blocking' : 'clean' })
  }
  return reviews
}

export function stopsFromEvents(history: DecodedHistory): ChildFacts['stops'] {
  const stops: ChildFacts['stops'] = []
  for (const { record, payload } of epicEvents(history)) {
    if (payload.event !== 'goal-stop') continue
    const run = eventText(payload, 'run')
    const reason = eventText(payload, 'reason')
    if (run !== null && reason !== null && record.runId === run) stops.push({ run, reason })
  }
  return stops
}

export function hooksFromEvents(history: DecodedHistory): Facts['hooks'] {
  const hooks: Facts['hooks'] = []
  for (const { record, payload } of epicEvents(history)) {
    if (payload.event !== 'post-merge') continue
    const run = eventText(payload, 'run')
    const result = eventText(payload, 'result')
    const sha = eventText(payload, 'sha')
    if (
      run !== null &&
      sha !== null &&
      record.runId === run &&
      (result === 'started' || result === 'ok' || result === 'skipped' || result === 'failed')
    ) {
      hooks.push({ run, result, sha })
    }
  }
  return hooks
}

export function hasEpicFixEvent(history: DecodedHistory): boolean {
  return epicEvents(history).some(
    ({ record, payload }) => payload.event === 'epic-fix' && eventText(payload, 'run') === record.runId,
  )
}
