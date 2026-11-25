import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import { sameJson } from './history-conservation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { type SpecReport, specReportSchema } from './record-values.ts'
import type { FindingInspection, Result } from './result.ts'
import { catalogueForAction, type ReviewClassCatalogues } from './review-class-catalogue.ts'
import { accounted } from './review-context-authentication.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Slot = Inventory['payload']['slots'][number]

/** Structural slot equality; the caller chooses observation or positive authority. */
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
      canonicalValueDigest(source.payload.host.action) === canonicalValueDigest(slot.action))
  )
}

const unavailable = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('cause-source-unconfirmed', 'Original contribution action provenance is not authenticated')],
})

function originalContributionSlot(
  source: Contribution,
  history: DecodedHistory,
): { inventory: Inventory; slot: Slot; inputs: ActionInputs } | null {
  if (
    !accounted(history, source) ||
    source.payload.inventoryId === null ||
    !source.inputs.includes(source.payload.inventoryId)
  )
    return null
  const inventories = history.operations.flatMap((operation) =>
    operation.authority !== 'foreign' &&
    operation.record?.kind === 'review-attempt' &&
    operation.record.recordId === source.payload.inventoryId
      ? [operation.record]
      : [],
  )
  const inventory = inventories[0]
  if (inventories.length !== 1 || inventory === undefined || !accounted(history, inventory)) return null
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
    return null
  return { inventory, slot, inputs: slot.action.inputs }
}

/** Authenticate immutable producer capture; current Spec and execution authority belong to the caller. */
export function originalContributionAction(
  source: Contribution,
  history: DecodedHistory,
  histories: readonly DecodedHistory[] = [history],
): Result<ActionInputs> {
  const capture = originalContributionSlot(source, history)
  return capture === null ? unavailable() : authenticateHistoricalActionInputs(capture.inputs, histories)
}

/** Only an initial spec-review slot bound to the caller's authenticated snapshot may supply criterion rows. */
export function reviewCriterionReport(
  source: Contribution,
  history: DecodedHistory,
  selectedInputs: ActionInputs,
): SpecReport | null {
  const capture = originalContributionSlot(source, history)
  const payload = source.payload
  const structured = payload.structured
  if (
    capture === null ||
    capture.inventory.payload.stage !== 'initial' ||
    capture.inventory.payload.purpose !== 'review' ||
    capture.inventory.payload.rootAttemptId !== capture.inventory.recordId ||
    capture.slot.role !== 'R-review-spec' ||
    capture.slot.phase !== 'spec' ||
    capture.slot.output !== 'spec' ||
    (capture.inventory.payload.inputSnapshot !== selectedInputs &&
      canonicalValueDigest(capture.inventory.payload.inputSnapshot) !== canonicalValueDigest(selectedInputs)) ||
    payload.content !== 'findings' ||
    payload.findings === null ||
    payload.native?.completion !== 'completed' ||
    payload.native.strict !== 'valid' ||
    structured === null ||
    !payload.rawAttempts.some((attempt) => sameJson(attempt.data, structured))
  )
    return null
  return specReportSchema.safeParse(structured).data ?? null
}

export function inspectContributionFindings(
  source: Contribution,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  histories: readonly DecodedHistory[] = [history],
): ReadonlyMap<string, FindingInspection> {
  const inspections = new Map<string, FindingInspection>()
  const action = originalContributionAction(source, history, histories)
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
