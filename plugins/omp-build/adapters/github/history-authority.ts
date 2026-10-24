import type { History, OperationAuthority } from '../../engine/history-schema.ts'
import { stopBotMayAuthor, WORKFLOW_RECORD_KINDS } from '../../engine/record-references.ts'
import type { ClaimedOperation, LooseHeaderClue, UnclaimedOperation } from './types.ts'
import { decodeHeaderIdentifier } from './types.ts'

const KNOWN_KINDS: Record<string, true> = {
  'review-attempt': true,
  contribution: true,
  decision: true,
  review: true,
  'fix-request': true,
  'fix-result': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
  proof: true,
  stop: true,
  'epic-event': true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true as const])),
}

const ACCOUNTED_KINDS: Record<string, true> = {
  proof: true,
  'epic-event': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
  'fix-result': true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true as const])),
}

export function looseHeaderClue(comment: History['comments'][number]): LooseHeaderClue {
  const newline = comment.body.indexOf('\n')
  const header = comment.body.slice(0, newline === -1 ? comment.body.length : newline)
  const headerValue = (field: string): string | null => {
    const value = new RegExp(`\\b${field}=([^\\s<>]+)`).exec(header)?.[1]
    return value === undefined ? null : (decodeHeaderIdentifier(value) ?? value)
  }

  return {
    comment,
    operationId: headerValue('operationId'),
    recordId: headerValue('id'),
    kind: headerValue('kind'),
  }
}

export function withClaimedKinds(operation: UnclaimedOperation): ClaimedOperation {
  const { parsedKind, ...read } = operation
  const claimedKinds: string[] = []
  const claim = (kind: string | null | undefined) => {
    if (kind !== null && kind !== undefined && !claimedKinds.includes(kind)) claimedKinds.push(kind)
  }

  for (const part of read.parts) claim(looseHeaderClue(part).kind)
  claim(read.kind)
  claim(parsedKind)
  claim(read.record?.kind)

  return { ...read, claimedKinds: claimedKinds.sort() }
}

function hasConflictingPartMetadata(operation: ClaimedOperation, kind: string | null): boolean {
  const clues = operation.parts.map(looseHeaderClue)
  const kinds = new Set(clues.map((clue) => clue.kind).filter((value): value is string => value !== null))
  const recordIds = new Set(clues.map((clue) => clue.recordId).filter((value): value is string => value !== null))
  return (
    kinds.size > 1 ||
    (kind !== null && kinds.size === 1 && !kinds.has(kind)) ||
    recordIds.size > 1 ||
    (operation.recordId !== null && recordIds.size === 1 && !recordIds.has(operation.recordId))
  )
}

function collidesWithOtherOperation(operation: ClaimedOperation, clues: LooseHeaderClue[]): boolean {
  const ownParts = new Set(operation.parts.map((part) => part.locator))
  return clues.some(
    (clue) =>
      !ownParts.has(clue.comment.locator) &&
      ((operation.operationId !== null && clue.operationId === operation.operationId) ||
        (operation.recordId !== null && clue.recordId === operation.recordId)),
  )
}

function hasInvalidAuthoritySource(
  operation: ClaimedOperation,
  kind: string | null,
  clues: LooseHeaderClue[],
): boolean {
  const authors = new Set(operation.parts.map((part) => part.author))
  return (
    kind === null ||
    KNOWN_KINDS[kind] === undefined ||
    authors.size !== 1 ||
    authors.has(null) ||
    !operation.parts.every((part) => part.nativeId !== null) ||
    hasConflictingPartMetadata(operation, kind) ||
    collidesWithOtherOperation(operation, clues)
  )
}

function isCompleteCorrection(operation: ClaimedOperation): boolean {
  return (
    operation.status === 'complete' &&
    operation.record !== null &&
    (operation.record.kind === 'fix-request' ||
      (operation.record.kind === 'review-attempt' && operation.record.payload.purpose === 'correction'))
  )
}

export function operationAuthority(
  operation: ClaimedOperation,
  history: History,
  clues: LooseHeaderClue[],
): OperationAuthority {
  const kind = operation.record?.kind ?? operation.kind
  const author = operation.parts[0]?.author
  if (author === null || author === undefined) return 'authority'
  const trusted =
    author === history.expectedAuthor || (author === history.stopAuthor && stopBotMayAuthor(operation.claimedKinds))
  if (!trusted) return 'foreign'
  if (kind === null || hasInvalidAuthoritySource(operation, kind, clues)) return 'authority'
  if (operation.claimedKinds.some((claim) => claim !== kind)) return 'authority'
  if (isCompleteCorrection(operation)) return 'accounted'
  if (kind === 'review' || kind === 'stop') return 'authority'

  return ACCOUNTED_KINDS[kind] === true ? 'accounted' : 'authority'
}
