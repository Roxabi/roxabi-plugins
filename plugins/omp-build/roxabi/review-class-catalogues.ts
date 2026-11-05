import type { Gh } from '../adapters/github/types.ts'
import {
  actionInputsSchema,
  createReviewClassCatalogues,
  recordsOf,
  reviewClassCatalogueRef,
} from '../dist/contracts.js'
import type { PinnedFileRef } from '../engine/action-input-refs.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ReviewCatalogueRead, ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import { actionFailure } from './uw-action-result.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'

/** Candidate discovery loads content only; producing-source authentication remains in the engine. */
function capturedActions(histories: readonly DecodedHistory[], candidates: readonly ActionInputs[]): ActionInputs[] {
  const actions = [...candidates]
  const add = (value: unknown) => {
    const parsed = actionInputsSchema.safeParse(value)
    if (parsed.success) actions.push(parsed.data)
  }
  for (const history of histories) for (const record of recordsOf(history)) addCapturedRecord(record, add)
  return actions
}

function addCapturedRecord(record: ReturnType<typeof recordsOf>[number], add: (value: unknown) => void): void {
  if (record.kind === 'review-attempt') {
    if ('inputSnapshot' in record.payload) add(record.payload.inputSnapshot)
    addSlotActions(record.payload.slots, add)
  } else if (record.kind === 'contribution') {
    if (record.payload.host.action !== undefined) add(record.payload.host.action.inputs)
  } else if (record.kind === 'action-receipt') {
    add(record.payload.inputs)
    if ('slots' in record.payload) addSlotActions(record.payload.slots, add)
  }
}

function addSlotActions(slots: readonly { action?: { inputs: unknown } }[], add: (value: unknown) => void): void {
  for (const slot of slots) if (slot.action !== undefined) add(slot.action.inputs)
}

const coordinates = (ref: PinnedFileRef) => `${ref.repository}\0${ref.commit}\0${ref.path}`
const identity = (ref: PinnedFileRef) => `${coordinates(ref)}\0${ref.digest}`

/** Read exact captured plugin pins, independently retaining each failed observation. */
export async function loadReviewClassCatalogues(input: {
  histories: readonly DecodedHistory[]
  candidateInputs?: readonly ActionInputs[]
  cwd: string
  gh: Gh
}): Promise<ReviewClassCatalogues> {
  const refs = new Map<string, PinnedFileRef>()
  for (const action of capturedActions(input.histories, input.candidateInputs ?? [])) {
    const ref = reviewClassCatalogueRef(action)
    if (ref.ok) refs.set(identity(ref.value), ref.value)
  }
  const digests = new Map<string, Set<string>>()
  const groups = new Map<string, PinnedFileRef[]>()
  for (const ref of refs.values()) {
    const key = coordinates(ref)
    const claimed = digests.get(key) ?? new Set<string>()
    claimed.add(ref.digest)
    digests.set(key, claimed)
    const group = `${ref.repository}\0${ref.commit}`
    const members = groups.get(group) ?? []
    members.push(ref)
    groups.set(group, members)
  }
  const reads: ReviewCatalogueRead[] = []
  for (const group of groups.values()) {
    // One exact read per reference keeps an unreadable historical pin from poisoning its peers.
    const observed = await Promise.all(
      group.map(
        async (ref): Promise<ReviewCatalogueRead> => ({
          ref,
          contents:
            (digests.get(coordinates(ref))?.size ?? 0) > 1
              ? actionFailure(
                  'action-input-stale',
                  `Conflicting catalogue digests for ${ref.repository}@${ref.commit}:${ref.path}`,
                )
              : await readGitFileBytes({
                  repository: ref.repository,
                  commit: ref.commit,
                  path: ref.path,
                  cwd: input.cwd,
                  gh: input.gh,
                }),
        }),
      ),
    )
    reads.push(...observed)
  }
  return createReviewClassCatalogues(reads)
}
