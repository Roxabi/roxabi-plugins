import { createHash } from 'node:crypto'
import type { FixRecoveryObservation } from './fix-recovery-control-schema.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import { inheritObservedGitPins } from './historical-git-pins.ts'
import { looseHeaderClue, operationAuthority, withClaimedKinds } from './history-authority.ts'
import { decodeParts, frameFrom } from './history-framing.ts'
import type { DecodedHistory, History } from './history-schema.ts'
import type { Frame } from './history-wire-types.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { scopeKey, validateUwGraphContents } from './uw-graph.ts'

/** Check recorded graph content without manufacturing native observation timestamps. */
export function validRecoveryHistoricalGraph(graph: FixRecoveryObservation['graph']): boolean {
  const ordered = (values: readonly string[]) =>
    values.every((value, index) => {
      const previous = values[index - 1]
      return index === 0 || (previous !== undefined && previous < value)
    })
  if (!ordered(graph.nodes.map((node) => scopeKey(node.uw))) || !validateUwGraphContents(graph.root, graph.nodes).ok)
    return false
  return graph.nodes.every(
    (node) =>
      createHash('sha256').update(node.raw.body, 'utf8').digest('hex') === node.raw.bodySha256 &&
      ordered(node.labels) &&
      ordered(node.wayfinderLabels) &&
      ordered(node.children.map(scopeKey)) &&
      ordered(node.blockers.map(scopeKey)),
  )
}

/** Private historical reconstruction, never a current native-read or execution capability. */
export function reconstructRecoveryHistoricalCut(
  cuts: FixRecoveryObservation['histories'],
  histories: readonly DecodedHistory[],
): Result<DecodedHistory[]> {
  const snapshots: DecodedHistory[] = []
  for (const cut of cuts) {
    if (snapshots.some((snapshot) => equalScope(snapshot.source.scope, cut.scope)))
      return { ok: false, diagnostics: [diagnostic('ambiguous', 'Recovery snapshot repeats a history scope')] }
    const snapshot = reconstructScope(cut, histories)
    if (!snapshot.ok) return snapshot
    snapshots.push(snapshot.value)
  }
  return { ok: true, value: snapshots }
}

function reconstructScope(
  cut: FixRecoveryObservation['histories'][number],
  histories: readonly DecodedHistory[],
): Result<DecodedHistory> {
  const matching = histories.filter((history) => equalScope(history.source.scope, cut.scope))
  const actual = matching[0]
  if (matching.length !== 1 || actual === undefined || !actual.source.complete)
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Recovery snapshot source is unavailable')] }
  const selected = selectComments(cut, actual)
  if (!selected.ok) return selected
  const source: History = {
    scope: cut.scope,
    expectedAuthor: cut.expectedAuthor,
    stopAuthor: cut.stopAuthor,
    complete: true,
    comments: selected.value,
    diagnostics: [],
  }
  inheritObservedGitPins(actual.source, source)
  return decodeHistoricalSource(source)
}

function selectComments(
  cut: FixRecoveryObservation['histories'][number],
  actual: DecodedHistory,
): Result<History['comments']> {
  const comments: History['comments'] = []
  for (const pin of cut.parts) {
    const matches = actual.source.comments.filter((comment) => {
      const actualPin = commentAsPartPin(comment)
      return actualPin !== null && partPinsEqual(actualPin, pin)
    })
    const match = matches[0]
    if (matches.length !== 1 || match === undefined || comments.some((comment) => comment.nativeId === pin.nativeId))
      return {
        ok: false,
        diagnostics: [diagnostic('ambiguous', 'Recovery snapshot part is missing, changed, or duplicated')],
      }
    comments.push(match)
  }
  return { ok: true, value: comments }
}

function decodeHistoricalSource(source: History): Result<DecodedHistory> {
  const groups = new Map<string, Frame[]>()
  for (const comment of source.comments) {
    const frame = frameFrom(comment)
    if (frame === null || 'diagnostic' in frame)
      return {
        ok: false,
        diagnostics: [diagnostic('ambiguous', 'Recovery snapshot contains an invalid protocol frame')],
      }
    groups.set(frame.operationId, [...(groups.get(frame.operationId) ?? []), frame])
  }
  const clues = source.comments.map(looseHeaderClue)
  const operations: DecodedHistory['operations'] = []
  const diagnostics: DecodedHistory['diagnostics'] = []
  for (const [operationId, frames] of groups) {
    const decoded = decodeParts(source.scope, source.expectedAuthor, source.stopAuthor, operationId, frames)
    const claimed = withClaimedKinds(decoded.operation)
    const authority = operationAuthority(claimed, source, clues)
    if (
      authority === 'foreign' ||
      claimed.status === 'conflict' ||
      claimed.status === 'invalid' ||
      claimed.status === 'legacy'
    )
      return {
        ok: false,
        diagnostics: [diagnostic('ambiguous', 'Recovery snapshot contains an unauthenticated or invalid operation')],
      }
    operations.push({ ...claimed, authority })
    diagnostics.push(...decoded.diagnostics)
  }
  return { ok: true, value: { source, operations, diagnostics } }
}
