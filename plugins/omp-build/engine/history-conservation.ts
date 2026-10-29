import { missingContextOutputSchema } from './action-context.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import {
  actionResultSchema,
  type Diagnostic,
  findingReportSchema,
  type Json,
  specReportSchema,
} from './record-values.ts'
import { decisionSchema } from './review-schema.ts'

export function inventoryRoot(
  records: Map<string, CanonicalRecord>,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
): Extract<CanonicalRecord, { kind: 'review-attempt' }> | null {
  const root = records.get(inventory.payload.rootAttemptId)
  return root?.kind === 'review-attempt' ? root : null
}
function isJsonObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameJsonArray(left: Json[], right: Json): boolean {
  if (!Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const entry = left[index]
    const candidate = right[index]
    if (entry === undefined || candidate === undefined || !sameJson(entry, candidate)) return false
  }
  return true
}

function sameJsonObject(left: { [key: string]: Json }, right: Json): boolean {
  if (!isJsonObject(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    const entry = left[key]
    const candidate = right[key]
    if (entry === undefined || candidate === undefined || !sameJson(entry, candidate)) return false
  }
  return true
}

export function sameJson(left: Json, right: Json): boolean {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  return Array.isArray(left) ? sameJsonArray(left, right) : isJsonObject(left) && sameJsonObject(left, right)
}

export function capturedFindingMembers(value: Json): Json[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.findings)) return null
  return value.findings
}

type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Slot = ReviewAttempt['payload']['slots'][number]

function matchingSlot(
  record: Contribution,
  slots: Map<string, Slot>,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): Slot | null {
  const slotId = record.payload.host.slotId
  if (slotId === null || !slots.has(slotId)) {
    if (enforceClosure)
      diagnostics.push(
        diagnostic('unknown-reference', `Contribution ${record.recordId} names no inventory slot`, record.recordId),
      )
    return null
  }
  return slots.get(slotId) ?? null
}

function validateSlotProvenance(
  record: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (
    enforceClosure &&
    (record.payload.host.phase !== slot.phase ||
      record.payload.host.role !== slot.role ||
      record.payload.host.chunk !== slot.chunk)
  )
    diagnostics.push(
      diagnostic('unbound', `Contribution ${record.recordId} host provenance does not match slot ${slot.slotId}`),
    )
}

function matchedSlotContributions(
  records: Map<string, CanonicalRecord>,
  inventory: ReviewAttempt,
  slots: Map<string, Slot>,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): Map<string, Contribution[]> {
  const matched = new Map<string, Contribution[]>()
  for (const record of records.values()) {
    if (record.kind !== 'contribution' || record.payload.inventoryId !== inventory.recordId) continue
    const slot = matchingSlot(record, slots, diagnostics, enforceClosure)
    if (slot === null) continue
    validateSlotProvenance(record, slot, diagnostics, enforceClosure)
    const entries = matched.get(slot.slotId) ?? []
    entries.push(record)
    matched.set(slot.slotId, entries)
  }
  return matched
}

function validateRequiredProvenance(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (
    enforceClosure &&
    slot.required &&
    (entry.payload.host.origin !== 'native' || entry.payload.host.childId === null)
  )
    diagnostics.push(diagnostic('unbound', `Required slot ${slot.slotId} lacks observed native child provenance`))
}

function validateRequiredRawAttempts(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (
    enforceClosure &&
    slot.required &&
    entry.payload.host.origin === 'native' &&
    entry.payload.rawAttempts.length === 0
  )
    diagnostics.push(
      diagnostic('incomplete', `Required native contribution ${entry.recordId} retained no raw submissions`),
    )
}

function validateRequiredNativeOutcome(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (
    enforceClosure &&
    slot.required &&
    entry.payload.host.origin === 'native' &&
    (entry.payload.native === null ||
      entry.payload.native.strict !== 'valid' ||
      entry.payload.native.completion !== 'completed')
  )
    diagnostics.push(
      diagnostic('incomplete', `Required native contribution ${entry.recordId} has no valid completed outcome`),
    )
}

function validateRequiredStructure(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (enforceClosure && slot.required && entry.payload.structured === null)
    diagnostics.push(diagnostic('malformed', `Required slot ${slot.slotId} has no structured output`))
}

function validateRequiredFindings(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (enforceClosure && slot.required && entry.payload.content === 'findings' && entry.payload.findings === null)
    diagnostics.push(
      diagnostic('unusable-finding', `Required finding contribution ${entry.recordId} has no extractable findings`),
    )
}

function validateSlotContent(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  const expectedContent =
    slot.output === 'decision' ? 'decision' : slot.output === 'action-result' ? 'action-result' : 'findings'
  if (enforceClosure && entry.payload.content !== expectedContent)
    diagnostics.push(
      diagnostic('unbound', `Contribution ${entry.recordId} content does not satisfy slot ${slot.slotId}`),
    )
  if (enforceClosure && missingContextOutputSchema.safeParse(entry.payload.structured).success)
    diagnostics.push(
      diagnostic(
        'incomplete',
        `Contribution ${entry.recordId} requires expanded context and cannot close slot ${slot.slotId}`,
      ),
    )
  validateRequiredProvenance(entry, slot, diagnostics, enforceClosure)
  validateRequiredRawAttempts(entry, slot, diagnostics, enforceClosure)
  validateRequiredNativeOutcome(entry, slot, diagnostics, enforceClosure)
  validateRequiredStructure(entry, slot, diagnostics, enforceClosure)
  validateStructuredSlotContent(entry, slot, diagnostics, enforceClosure)
  validateRequiredFindings(entry, slot, diagnostics, enforceClosure)
}

function validateStructuredSlotContent(
  entry: Contribution,
  slot: Slot,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  if (
    enforceClosure &&
    entry.payload.structured !== null &&
    slot.output === 'findings' &&
    !findingReportSchema.safeParse(entry.payload.structured).success
  )
    diagnostics.push(
      diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a finding report`),
    )
  if (
    enforceClosure &&
    entry.payload.structured !== null &&
    slot.output === 'spec' &&
    !specReportSchema.safeParse(entry.payload.structured).success
  )
    diagnostics.push(diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a spec report`))
  if (
    enforceClosure &&
    entry.payload.structured !== null &&
    slot.output === 'decision' &&
    !decisionSchema.safeParse(entry.payload.structured).success
  )
    diagnostics.push(diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a decision`))
  if (
    enforceClosure &&
    entry.payload.structured !== null &&
    slot.output === 'action-result' &&
    !actionResultSchema.safeParse(entry.payload.structured).success
  )
    diagnostics.push(
      diagnostic('malformed', `Contribution ${entry.recordId} structured output is not an action result`),
    )
}

export function requiredSlotsComplete(
  records: Map<string, CanonicalRecord>,
  inventory: ReviewAttempt,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  const slots = new Map(inventory.payload.slots.map((slot) => [slot.slotId, slot]))
  if (slots.size !== inventory.payload.slots.length)
    diagnostics.push(diagnostic('duplicate-reference', `Inventory ${inventory.recordId} repeats a slot ID`))
  const matched = matchedSlotContributions(records, inventory, slots, diagnostics, enforceClosure)
  for (const slot of inventory.payload.slots) {
    const entries = matched.get(slot.slotId) ?? []
    if (enforceClosure && entries.length > 1)
      diagnostics.push(diagnostic('duplicate-reference', `Slot ${slot.slotId} has multiple contributions`))
    if (enforceClosure && slot.required && entries.length !== 1)
      diagnostics.push(diagnostic('missing-contribution', `Required slot ${slot.slotId} is not closed`))
    for (const entry of entries) validateSlotContent(entry, slot, diagnostics, enforceClosure)
  }
}
