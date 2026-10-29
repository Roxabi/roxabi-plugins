import { missingContextOutputSchema } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import {
  accounted,
  negativeFor,
  resolvedOutputValid,
  same,
  successorSlotEntry,
  unresolvedStepValid,
} from './review-context-authentication.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'

type Root = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

/** Stable per-slot identity; an expansion names the actual requested context, not a run. */
export function reviewActionId(candidate: string, slot: string, expanded: readonly unknown[]): string {
  if (expanded.length === 0) return `${candidate}:${slot}`
  return `${candidate}:${slot}:context:${canonicalValueDigest(expanded.map(canonicalValueDigest).sort())}`
}

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
  proposed?: Root,
): Root[] {
  const authenticated = roots.filter((candidate) => candidate === proposed || accounted(history, candidate))
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

function resolvedSuccessor(
  history: DecodedHistory,
  roots: readonly Root[],
  contributions: readonly Contribution[],
  root: Root,
  entry: Contribution,
  slotId: Contribution['payload']['host']['slotId'],
) {
  if (slotId === null) return null
  const successors = directReviewContextSuccessors(history, roots, contributions, root, entry)
  if (successors.length !== 1) return null
  const nextRoot = successors[0]
  if (nextRoot === undefined || !isInitialPullRequestReviewInventory(nextRoot.payload)) return null
  const slotEntry = successorSlotEntry(history, nextRoot, contributions, slotId)
  if (slotEntry === undefined) return null
  return { root: nextRoot, inputSnapshot: nextRoot.payload.inputSnapshot, ...slotEntry }
}

function resolvedNegative(
  history: DecodedHistory,
  roots: readonly Root[],
  contributions: readonly Contribution[],
  records: readonly CanonicalRecord[],
  negative: Contribution,
): boolean {
  let root = roots.find((candidate) => negativeFor(history, candidate, negative))
  if (root === undefined) return false
  let entry = negative
  const slotId = negative.payload.host.slotId
  const seen = new Set<string>()
  while (true) {
    const current = root
    if (!unresolvedStepValid(history, current, entry, contributions, records, seen)) return false
    const successor = resolvedSuccessor(history, roots, contributions, current, entry, slotId)
    if (successor === null) return false
    root = successor.root
    const { next, slot, inputSnapshot } = successor
    if (missingContextOutputSchema.safeParse(next.payload.structured).success) {
      if (!negativeFor(history, root, next)) return false
      entry = next
      continue
    }
    return resolvedOutputValid(next, slot, root.recordId, inputSnapshot)
  }
}

/** Check a proposed successor against authenticated history before publication or dispatch. */
export function authorizeReviewContextSuccessor(history: DecodedHistory, proposed: Root): boolean {
  if (!isInitialPullRequestReviewInventory(proposed.payload)) return true
  const refs = proposed.payload.inputSnapshot.manifest.expandedContext
  if (refs.length === 0) return true
  if (!history.source.complete || history.diagnostics.length !== 0) return false
  const records = history.operations.flatMap((operation) => (operation.record === null ? [] : [operation.record]))
  const roots = records.filter(
    (record): record is Root => record.kind === 'review-attempt' && isInitialPullRequestReviewInventory(record.payload),
  )
  const contributions = records.filter((record): record is Contribution => record.kind === 'contribution')
  const cited = refs.flatMap((ref) => {
    if (ref.source !== 'record' || ref.record.kind !== 'contribution' || ref.selector !== '/payload') return []
    return contributions
      .filter(
        (entry) =>
          entry.recordId === ref.record.recordId &&
          equalScope(entry, ref.record.scope) &&
          missingContextOutputSchema.safeParse(entry.payload.structured).success,
      )
      .map((entry) => ({ entry, ref }))
  })
  if (cited.length === 0) return true
  if (cited.some(({ entry, ref }) => !accounted(history, entry) || ref.digest !== canonicalValueDigest(entry.payload)))
    return false
  const allRoots = [...roots.filter((root) => root.recordId !== proposed.recordId), proposed]
  const matches = roots.flatMap((root) =>
    contributions
      .filter((entry) => negativeFor(history, root, entry))
      .flatMap((entry) => {
        const successors = directReviewContextSuccessors(history, allRoots, contributions, root, entry, proposed)
        if (successors.length > 1 && successorOf(root, proposed, entry)) return [{ root, entry, fork: true }]
        return successors.some((candidate) => candidate.recordId === proposed.recordId)
          ? [{ root, entry, fork: false }]
          : []
      }),
  )
  const match = matches[0]
  if (matches.length === 0)
    return cited.every(({ entry }) => {
      const inventory = records.find(
        (candidate) =>
          candidate.kind === 'review-attempt' &&
          candidate.recordId === entry.payload.inventoryId &&
          equalScope(candidate, entry),
      )
      if (inventory?.kind !== 'review-attempt' || !accounted(history, inventory)) return false
      if (inventory.payload.purpose !== 'review') return true
      const root = roots.find((candidate) => candidate.recordId === inventory.recordId)
      return root !== undefined && resolvedNegative(history, roots, contributions, records, entry)
    })
  if (matches.length !== 1 || match === undefined || match.fork) return false
  const { root, entry } = match
  if (
    contributions.filter(
      (candidate) =>
        candidate.payload.inventoryId === root.recordId && candidate.payload.host.slotId === entry.payload.host.slotId,
    ).length !== 1
  )
    return false
  if (contributions.filter((candidate) => negativeFor(history, root, candidate)).length !== 1) return false
  if (records.some((record) => record.kind === 'review' && record.payload.inventoryIds.includes(root.recordId)))
    return false
  return true
}

/** A negative inventory cannot authorize a late final after a successor exists. */
export function reviewInventoryHasContextNegative(history: DecodedHistory, inventoryIds: readonly string[]): boolean {
  const records = history.operations.flatMap((operation) => (operation.record === null ? [] : [operation.record]))
  const roots = records.filter(
    (record): record is Root => record.kind === 'review-attempt' && inventoryIds.includes(record.recordId),
  )
  const contributions = records.filter((record): record is Contribution => record.kind === 'contribution')
  return roots.some((root) => contributions.some((entry) => negativeFor(history, root, entry)))
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
