import type { PinnedFileRef } from './action-input-schema.ts'
import type { FixRecoveryObservation } from './fix-recovery-control-schema.ts'
import { withGitPinBytes } from './historical-git-pins.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import {
  createReviewClassCatalogues,
  type ReviewClassCatalogues,
  reviewClassCatalogueRef,
} from './review-class-catalogue.ts'
import { originalContributionAction } from './review-original-action.ts'
import { recordsOf } from './workflow-control.ts'

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
const coordinate = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path])
const identity = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path, ref.digest])

/** The exact historical catalogue pins actually consulted for this selected decision. */
function fixRecoveryDecisionCatalogueRefs(input: {
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  history: DecodedHistory
  histories: readonly DecodedHistory[]
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
    const action = originalContributionAction(source, input.history, input.histories)
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

/** Validate embedded bytes and expose them only to this adoption's historical input checks. */
export function readFixRecoveryCatalogues(input: {
  observation: FixRecoveryObservation
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  history: DecodedHistory
  histories: readonly DecodedHistory[]
}): Result<{ catalogues: ReviewClassCatalogues; histories: readonly DecodedHistory[] }> {
  const entries = input.observation.catalogues ?? []
  const files: { ref: PinnedFileRef; bytes: Uint8Array }[] = []
  const seen = new Set<string>()
  const coordinates = new Set<string>()
  for (const entry of entries) {
    const id = identity(entry.ref)
    const coord = coordinate(entry.ref)
    if (seen.has(id) || coordinates.has(coord))
      return fail('Historical catalogue pin is duplicate, foreign or conflicting')
    seen.add(id)
    coordinates.add(coord)
    const bytes = new TextEncoder().encode(entry.contents)
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== entry.contents)
      return fail('Historical catalogue contents are not the exact valid pinned UTF-8 bytes')
    files.push({ ref: entry.ref, bytes })
  }
  const catalogues = createReviewClassCatalogues(
    files.map(({ ref, bytes }) => ({ ref, contents: { ok: true, value: bytes } })),
  )
  for (const id of seen)
    if (!catalogues.lookup(id)?.ok)
      return fail('Historical catalogue contents are not the exact valid pinned UTF-8 bytes')
  const home = files.length === 0 ? input.history : withGitPinBytes(input.history, files)
  const histories =
    home === input.history ? input.histories : input.histories.map((entry) => (entry === input.history ? home : entry))
  const required = fixRecoveryDecisionCatalogueRefs({ decision: input.decision, history: home, histories })
  if (!required.ok) return required
  if (required.value.length !== seen.size || required.value.some((ref) => !seen.has(identity(ref))))
    return fail('Historical catalogue pins do not match the selected decision')
  return { ok: true, value: { catalogues, histories } }
}
