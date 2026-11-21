import { createHash } from 'node:crypto'
import type { PinnedFileRef } from './action-input-schema.ts'
import type { FixRecoveryObservation } from './fix-recovery-control-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import {
  createReviewClassCatalogues,
  parseReviewClassCatalogue,
  type ReviewClassCatalogues,
  reviewClassCatalogueRef,
} from './review-class-catalogue.ts'
import { originalContributionAction } from './review-original-action.ts'
import { recordsOf } from './workflow-control.ts'

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
const coordinate = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path])
const identity = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path, ref.digest])

/** The exact historical catalogue pins actually consulted for this selected decision. */
export function fixRecoveryDecisionCatalogueRefs(input: {
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  history: DecodedHistory
}): Result<PinnedFileRef[]> {
  const records = recordsOf(input.history)
  const refs = new Map<string, PinnedFileRef>()
  const coordinates = new Map<string, string>()
  for (const sourceId of input.decision.payload.judgment.sourceContributionIds) {
    const matches = records.filter((record) => record.kind === 'contribution' && record.recordId === sourceId)
    const source = matches[0]
    if (matches.length !== 1 || source?.kind !== 'contribution')
      return fail('Decision source contribution is not unique')
    if (source.payload.findings === null) continue
    const action = originalContributionAction(source, input.history)
    if (!action.ok) return action
    const ref = reviewClassCatalogueRef(action.value)
    if (!ref.ok) return ref
    const key = coordinate(ref.value)
    const previous = coordinates.get(key)
    if (previous !== undefined && previous !== ref.value.digest)
      return fail('Historical catalogue coordinates have conflicting digests')
    coordinates.set(key, ref.value.digest)
    refs.set(identity(ref.value), ref.value)
  }
  return { ok: true, value: [...refs.values()].sort((a, b) => identity(a).localeCompare(identity(b))) }
}

/** Decode only actual embedded pinned bytes; no current host reads or caller-supplied verdicts. */
export function readFixRecoveryCatalogues(input: {
  observation: FixRecoveryObservation
  required: readonly PinnedFileRef[]
}): Result<ReviewClassCatalogues> {
  const entries = input.observation.catalogues ?? []
  const required = new Map(input.required.map((ref) => [identity(ref), ref]))
  if (required.size !== input.required.length || entries.length !== required.size)
    return fail('Historical catalogue pins do not match the selected decision')
  const seen = new Set<string>()
  const coordinates = new Map<string, string>()
  const reads: Parameters<typeof createReviewClassCatalogues>[0][number][] = []
  for (const entry of entries) {
    const id = identity(entry.ref)
    const coord = coordinate(entry.ref)
    if (!required.has(id) || seen.has(id) || (coordinates.has(coord) && coordinates.get(coord) !== entry.ref.digest))
      return fail('Historical catalogue pin is duplicate, foreign or conflicting')
    seen.add(id)
    coordinates.set(coord, entry.ref.digest)
    const bytes = new TextEncoder().encode(entry.contents)
    if (
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== entry.contents ||
      createHash('sha256').update(bytes).digest('hex') !== entry.ref.digest ||
      !parseReviewClassCatalogue(entry.contents).ok
    )
      return fail('Historical catalogue contents are not the exact valid pinned UTF-8 bytes')
    reads.push({ ref: entry.ref, contents: { ok: true, value: bytes } })
  }
  return { ok: true, value: createReviewClassCatalogues(reads) }
}
