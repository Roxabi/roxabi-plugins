import type { History } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import { looseHeaderClue } from './history-authority.ts'
import type { Frame, FrameFailure, UnclaimedOperation } from './types.ts'
import { base64url, decodeHeaderIdentifier, decoder, diagnostic, HEADER, WIRE_PREFIX } from './types.ts'

export function frameFrom(comment: History['comments'][number]): Frame | FrameFailure | null {
  if (!comment.body.startsWith(WIRE_PREFIX)) return null

  const match = HEADER.exec(comment.body)
  if (match === null) {
    const clue = looseHeaderClue(comment)
    return {
      comment,
      operationId: clue.operationId,
      recordId: clue.recordId,
      kind: clue.kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has a malformed canonical record header`),
    }
  }

  const [, version, kind, recordIdText, operationIdText, partText, totalText, data] = match
  const recordId = decodeHeaderIdentifier(recordIdText)
  const operationId = decodeHeaderIdentifier(operationIdText)
  if (recordId === null || operationId === null) {
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has non-canonical record identifiers`),
    }
  }

  const part = Number(partText)
  const total = Number(totalText)
  if (part > total || !Number.isSafeInteger(part) || !Number.isSafeInteger(total)) {
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has an invalid part range`),
    }
  }

  return { comment, version, kind, recordId, operationId, part, total, data }
}

export function legacyKind(body: string): string | null {
  const marker = /^<!-- omp-build:([a-z][a-z0-9-]*)\b/.exec(body)
  if (marker === null || body.startsWith(WIRE_PREFIX)) return null
  return marker[1] === 'review' || marker[1] === 'final-review' ? 'review' : marker[1]
}

export function withOperationId(diagnostics: Diagnostic[], operationId: string | null): Diagnostic[] {
  return operationId === null ? diagnostics : diagnostics.map((entry) => ({ ...entry, operationId }))
}

function invalid(
  operationId: string,
  first: Frame,
  status: 'conflict' | 'incomplete' | 'invalid',
  parts: History['comments'],
  diagnostics: Diagnostic[],
  parsedKind?: string,
): { operation: UnclaimedOperation; diagnostics: Diagnostic[] } {
  return {
    operation: {
      operationId,
      recordId: first.recordId,
      kind: first.kind,
      status,
      parts,
      record: null,
      ...(parsedKind === undefined ? {} : { parsedKind }),
    },
    diagnostics,
  }
}

function hasConflictingMetadata(frames: Frame[], first: Frame): boolean {
  return !frames.every(
    (frame) =>
      frame.version === first.version &&
      frame.kind === first.kind &&
      frame.recordId === first.recordId &&
      frame.total === first.total,
  )
}

function nativeWriter(frames: Frame[], first: Frame): string | null {
  const author = first.comment.author
  if (author === null) return null
  return frames.every((frame) => frame.comment.nativeId !== null && frame.comment.author === author) ? author : null
}

type PartFrames = {
  frames: Map<number, Frame>
  conflict: number | null
}

function collectPartFrames(frames: Frame[]): PartFrames {
  const parts = new Map<number, Frame>()
  for (const frame of frames) {
    const existing = parts.get(frame.part)
    if (existing !== undefined && (existing.data !== frame.data || existing.comment.body !== frame.comment.body))
      return { frames: parts, conflict: frame.part }
    parts.set(frame.part, frame)
  }
  return { frames: parts, conflict: null }
}

function missingPart(parts: Map<number, Frame>, total: number): boolean {
  return parts.size !== total || [...parts.keys()].some((part) => part < 1 || part > total || !parts.has(part))
}

function decodeData(parts: Map<number, Frame>): string | null {
  try {
    const encoded = [...parts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, frame]) => frame.data)
      .join('')
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('non-canonical base64url')
    const bytes = Buffer.from(encoded, 'base64url')
    if (base64url(bytes) !== encoded) throw new Error('non-canonical base64url')
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

function nativeAuthorMatches(
  author: string | null,
  expectedAuthor: string,
  stopAuthor: string | null,
  kind: string,
  frames: Frame[],
): boolean {
  return (
    author === expectedAuthor ||
    (author === stopAuthor && kind === 'stop' && frames.every((frame) => frame.kind === 'stop'))
  )
}

function headerMatchesRecord(
  scope: History['scope'],
  operationId: string,
  first: Frame,
  record: CanonicalRecord,
): boolean {
  return (
    record.version === 1 &&
    record.kind === first.kind &&
    record.recordId === first.recordId &&
    record.operationId === operationId &&
    record.repository === scope.repository &&
    record.target === scope.target
  )
}

export function decodeParts(
  scope: History['scope'],
  expectedAuthor: string,
  stopAuthor: string | null,
  operationId: string,
  frames: Frame[],
): { operation: UnclaimedOperation; diagnostics: Diagnostic[] } {
  const parts = [...frames].sort((left, right) => left.part - right.part).map((frame) => frame.comment)
  const first = frames[0]
  if (first === undefined) throw new Error('decodeParts requires a frame')

  if (hasConflictingMetadata(frames, first)) {
    return invalid(operationId, first, 'conflict', parts, [
      diagnostic('conflicting-duplicate', `Operation ${operationId} repeats conflicting metadata`),
    ])
  }

  const author = nativeWriter(frames, first)
  const frameParts = collectPartFrames(frames)
  if (frameParts.conflict !== null) {
    return invalid(operationId, first, 'conflict', parts, [
      diagnostic('conflicting-duplicate', `Operation ${operationId} has conflicting part ${frameParts.conflict}`),
    ])
  }

  if (missingPart(frameParts.frames, first.total)) {
    return invalid(operationId, first, 'incomplete', parts, [
      diagnostic('incomplete', `Operation ${operationId} is missing required publication parts`),
    ])
  }

  const text = decodeData(frameParts.frames)
  if (text === null) {
    return invalid(operationId, first, 'invalid', parts, [
      diagnostic('invalid-encoding', `Operation ${operationId} has non-canonical UTF-8/base64url data`),
    ])
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid(operationId, first, 'invalid', parts, [
      diagnostic('invalid-json', `Operation ${operationId} data is not JSON`),
    ])
  }

  const parsed = parseRecord(raw)
  const headerAuthorized =
    author !== null && nativeAuthorMatches(author, expectedAuthor, stopAuthor, first.kind, frames)
  if (!parsed.ok) {
    return !headerAuthorized
      ? invalid(operationId, first, 'invalid', parts, [
          diagnostic('native-author-mismatch', `Operation ${operationId} has a wrong or inconsistent native writer`),
        ])
      : invalid(operationId, first, 'invalid', parts, parsed.diagnostics)
  }

  if (JSON.stringify(parsed.value) !== text) {
    return invalid(
      operationId,
      first,
      'invalid',
      parts,
      [diagnostic('non-canonical-json', `Operation ${operationId} data is not canonical JSON`)],
      parsed.value.kind,
    )
  }

  if (author === null || !nativeAuthorMatches(author, expectedAuthor, stopAuthor, parsed.value.kind, frames)) {
    return invalid(
      operationId,
      first,
      'invalid',
      parts,
      [diagnostic('native-author-mismatch', `Operation ${operationId} has a wrong or inconsistent native writer`)],
      parsed.value.kind,
    )
  }

  if (!headerMatchesRecord(scope, operationId, first, parsed.value)) {
    return invalid(
      operationId,
      first,
      'invalid',
      parts,
      [diagnostic('header-metadata-mismatch', `Operation ${operationId} header metadata does not bind its record`)],
      parsed.value.kind,
    )
  }

  return {
    operation: {
      operationId,
      recordId: first.recordId,
      kind: first.kind,
      status: 'complete',
      parts,
      record: parsed.value,
    },
    diagnostics: [],
  }
}
