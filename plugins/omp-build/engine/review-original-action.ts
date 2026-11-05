import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { FindingInspection, Result } from './result.ts'
import { catalogueForAction, type ReviewClassCatalogues } from './review-class-catalogue.ts'
import { accounted } from './review-context-authentication.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Slot = Extract<CanonicalRecord, { kind: 'review-attempt' }>['payload']['slots'][number]

export function matchesContributionSlot(source: Contribution, slot: Slot, inventoryId: string): boolean {
  return (
    source.inputs.includes(inventoryId) &&
    source.payload.host.origin === 'native' &&
    source.payload.host.childId !== null &&
    source.payload.host.slotId === slot.slotId &&
    source.payload.host.phase === slot.phase &&
    source.payload.host.role === slot.role &&
    source.payload.host.chunk === slot.chunk &&
    slot.action !== undefined &&
    (source.payload.host.action === undefined ||
      canonicalValueDigest(source.payload.host.action) === canonicalValueDigest(slot.action)) &&
    validateActionInputs(slot.action.inputs).ok
  )
}

const unavailable = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('cause-source-unconfirmed', 'Original contribution action provenance is not authenticated')],
})

/** Authenticate immutable producer capture; current Spec and execution authority belong to the caller. */
export function originalContributionAction(source: Contribution, history: DecodedHistory): Result<ActionInputs> {
  if (
    !accounted(history, source) ||
    source.payload.inventoryId === null ||
    !source.inputs.includes(source.payload.inventoryId)
  )
    return unavailable()
  const inventories = history.operations.flatMap((operation) =>
    operation.authority !== 'foreign' &&
    operation.record?.kind === 'review-attempt' &&
    operation.record.recordId === source.payload.inventoryId
      ? [operation.record]
      : [],
  )
  const inventory = inventories[0]
  if (inventories.length !== 1 || inventory === undefined || !accounted(history, inventory)) return unavailable()
  const slots = inventory.payload.slots.filter((slot) => slot.slotId === source.payload.host.slotId)
  const slot = slots[0]
  if (
    slots.length !== 1 ||
    slot === undefined ||
    slot.action === undefined ||
    !matchesContributionSlot(source, slot, inventory.recordId) ||
    slot.action.inputs.fingerprint !== inventory.payload.actionInputDigest ||
    slot.action.inputs.manifest.code.head !== inventory.payload.candidateGitSHA ||
    (inventory.payload.stage === 'initial' &&
      inventory.payload.purpose === 'review' &&
      canonicalValueDigest(slot.action.inputs) !== canonicalValueDigest(inventory.payload.inputSnapshot))
  )
    return unavailable()
  return { ok: true, value: slot.action.inputs }
}

export function inspectContributionFindings(
  source: Contribution,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): ReadonlyMap<string, FindingInspection> {
  const inspections = new Map<string, FindingInspection>()
  const action = originalContributionAction(source, history)
  const catalogue = action.ok ? catalogueForAction(action.value, catalogues) : action
  for (const original of source.payload.findings ?? []) {
    const inspection = inspectFinding(original.data, catalogue.ok ? catalogue.value : [])
    inspections.set(
      original.id,
      catalogue.ok
        ? inspection
        : {
            ...inspection,
            usable: false,
            diagnostics: [...inspection.diagnostics, ...catalogue.diagnostics],
          },
    )
  }
  return inspections
}
