import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { accounted, negativeFor, same } from './review-context-authentication.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'

type Root = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

function successorOf(root: Root, successor: Root, negative: Contribution): boolean {
  if (!isInitialPullRequestReviewInventory(root.payload) || !isInitialPullRequestReviewInventory(successor.payload))
    return false
  const old = root.payload.inputSnapshot
  const fresh = successor.payload.inputSnapshot
  const { expandedContext: before, ...oldManifest } = old.manifest
  const { expandedContext: after, ...newManifest } = fresh.manifest
  const ref = after.filter(
    (item) =>
      item.source === 'record' &&
      item.record.kind === 'contribution' &&
      item.record.recordId === negative.recordId &&
      equalScope(item.record.scope, negative) &&
      item.selector === '/payload' &&
      item.digest === canonicalValueDigest(negative.payload),
  )
  const oldRefs = new Set(before.map(canonicalValueDigest))
  const additions = after.filter((item) => !oldRefs.has(canonicalValueDigest(item)))
  const priorSources = new Set(
    [
      ...before,
      ...old.manifest.acceptedSources,
      ...old.manifest.deliveryData,
      ...old.manifest.repositoryReferences,
      ...old.stageSources,
    ].map(canonicalValueDigest),
  )
  const slots = (value: Root['payload']) => value.slots.map(({ action: _action, ...slot }) => slot)
  return (
    root.recordId !== successor.recordId &&
    successor.payload.rootAttemptId === successor.recordId &&
    successor.payload.replacement === undefined &&
    root.payload.candidateGitSHA === successor.payload.candidateGitSHA &&
    same(root.payload.tier, successor.payload.tier) &&
    same(root.payload.allocation, successor.payload.allocation) &&
    same(root.payload.policy, successor.payload.policy) &&
    same(slots(root.payload), slots(successor.payload)) &&
    same(oldManifest, newManifest) &&
    same(old.stageSources, fresh.stageSources) &&
    validateActionInputs(fresh).ok &&
    old.fingerprint !== fresh.fingerprint &&
    ref.length === 1 &&
    additions.some((item) => same(item, ref[0])) &&
    before.every((item) => after.some((candidate) => same(item, candidate))) &&
    additions.some((item) => !same(item, ref[0]) && !priorSources.has(canonicalValueDigest(item)))
  )
}

/** Direct edges require the intervening roots to cite their own authenticated negatives. */
export function directReviewContextSuccessors(
  history: DecodedHistory,
  roots: readonly Root[],
  contributions: readonly Contribution[],
  root: Root,
  negative: Contribution,
): Root[] {
  const authenticated = roots.filter((candidate) => accounted(history, candidate))
  const edges = (from: Root): Root[] => {
    const negatives = contributions.filter((entry) => negativeFor(history, from, entry))
    return authenticated.filter((candidate) => negatives.some((entry) => successorOf(from, candidate, entry)))
  }
  const candidates = authenticated.filter((candidate) => successorOf(root, candidate, negative))
  const reaches = (from: Root, target: Root, seen: Set<string>): boolean => {
    if (seen.has(from.recordId)) return false
    seen.add(from.recordId)
    return edges(from).some((next) => next.recordId === target.recordId || reaches(next, target, seen))
  }
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other.recordId !== candidate.recordId && reaches(other, candidate, new Set([root.recordId])),
      ),
  )
}

export function reviewContextLineage(
  history: DecodedHistory,
  records: ReadonlyMap<string, CanonicalRecord>,
): {
  superseded: Set<string>
  diagnostics: Diagnostic[]
} {
  const roots = [...records.values()].filter(
    (record): record is Root => record.kind === 'review-attempt' && isInitialPullRequestReviewInventory(record.payload),
  )
  const contributions = [...records.values()].filter((record): record is Contribution => record.kind === 'contribution')
  const superseded = new Set<string>()
  const diagnostics: Diagnostic[] = []
  for (const root of roots) {
    const negatives = contributions.filter((entry) => negativeFor(history, root, entry))
    if (negatives.length === 0) continue
    if (
      negatives.some(
        (entry) =>
          contributions.filter(
            (candidate) =>
              candidate.payload.inventoryId === root.recordId &&
              candidate.payload.host.slotId === entry.payload.host.slotId,
          ).length !== 1,
      )
    ) {
      diagnostics.push(
        diagnostic('duplicate-reference', `Review inventory ${root.recordId} has an ambiguous negative slot`),
      )
      continue
    }
    const successors = negatives.flatMap((entry) =>
      directReviewContextSuccessors(history, roots, contributions, root, entry),
    )
    const finals = [...records.values()].filter(
      (record) => record.kind === 'review' && record.payload.inventoryIds.includes(root.recordId),
    )
    if (finals.length > 0)
      diagnostics.push(
        diagnostic(
          'incomplete',
          `Review inventory ${root.recordId} has a context-negative result and cannot produce a final review`,
        ),
      )
    if (successors.length > 1 || negatives.length > 1) {
      diagnostics.push(
        diagnostic('duplicate-reference', `Review inventory ${root.recordId} has ambiguous context-negative lineage`),
      )
    } else if (successors.length === 1) superseded.add(root.recordId)
  }
  return { superseded, diagnostics }
}
