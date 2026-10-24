import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { projectRecord } from '../../engine/record-projection.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { RecordProjectionConfig, Result } from '../../engine/result.ts'
import { looseHeaderClue, operationAuthority, withClaimedKinds } from './history-authority.ts'
import { encodeParts } from './history-encoder.ts'
import { decodeParts, frameFrom, legacyKind, withOperationId } from './history-framing.ts'
import type { ClaimedOperation, Frame, FrameFailure, UnclaimedOperation } from './types.ts'
import { diagnostic, WIRE_PREFIX } from './types.ts'

function collectFrameGroups(comments: History['comments']) {
  const framed = new Map<string, Frame[]>()
  const invalidFrames = new Map<string, FrameFailure[]>()
  const legacy: UnclaimedOperation[] = []
  for (const comment of comments) {
    const frame = frameFrom(comment)
    if (frame === null) {
      const kind = legacyKind(comment.body)
      if (kind !== null)
        legacy.push({ operationId: null, recordId: null, kind, status: 'legacy', parts: [comment], record: null })
      continue
    }
    if ('diagnostic' in frame) {
      const key =
        frame.operationId === null
          ? `invalid:${frame.comment.locator}`
          : `invalid:${JSON.stringify([frame.operationId, frame.recordId, frame.kind])}`
      const entries = invalidFrames.get(key) ?? []
      entries.push(frame)
      invalidFrames.set(key, entries)
      continue
    }
    const entries = framed.get(frame.operationId) ?? []
    entries.push(frame)
    framed.set(frame.operationId, entries)
  }
  return { framed, invalidFrames, legacy }
}

function decodedInvalidOperations(invalidFrames: ReadonlyMap<string, readonly FrameFailure[]>) {
  const operations: UnclaimedOperation[] = []
  const diagnostics: Diagnostic[] = []
  for (const failures of invalidFrames.values()) {
    const firstFailure = failures[0]
    if (firstFailure === undefined) continue
    operations.push({
      operationId: firstFailure.operationId,
      recordId: firstFailure.recordId,
      kind: firstFailure.kind,
      status: 'invalid',
      parts: failures.map((failure) => failure.comment),
      record: null,
    })
    diagnostics.push(
      ...withOperationId(
        failures.map((failure) => failure.diagnostic),
        firstFailure.operationId,
      ),
    )
  }
  return { operations, diagnostics }
}

function decodedFramedOperations(history: History, framed: ReadonlyMap<string, Frame[]>) {
  const operations: UnclaimedOperation[] = []
  const diagnostics: Diagnostic[] = []
  for (const [operationId, frames] of framed) {
    const decoded = decodeParts(history.scope, history.expectedAuthor, history.stopAuthor, operationId, frames)
    operations.push(decoded.operation)
    diagnostics.push(...withOperationId(decoded.diagnostics, operationId))
  }
  return { operations, diagnostics }
}

function legacyDiagnostics(legacy: readonly UnclaimedOperation[]): Diagnostic[] {
  return legacy.map((operation) =>
    diagnostic(
      'legacy-format',
      `Legacy record marker at ${operation.parts[0]?.locator ?? 'unknown'} cannot be admitted`,
    ),
  )
}

/** Decode only the framed transport; human Markdown is intentionally never parsed. */
export function decodeHistory(history: History): DecodedHistory {
  const { framed, invalidFrames, legacy } = collectFrameGroups(history.comments)
  const invalid = decodedInvalidOperations(invalidFrames)
  const decoded = decodedFramedOperations(history, framed)
  const operations = [...invalid.operations, ...decoded.operations, ...legacy]
  const diagnostics = [...invalid.diagnostics, ...decoded.diagnostics, ...legacyDiagnostics(legacy)]
  const clues = history.comments.filter((comment) => comment.body.startsWith(WIRE_PREFIX)).map(looseHeaderClue)
  return {
    source: history,
    operations: operations.map((operation) => {
      const claimed: ClaimedOperation = withClaimedKinds(operation)
      return { ...claimed, authority: operationAuthority(claimed, history, clues) }
    }),
    diagnostics,
  }
}

/** Frame the full canonical record and its core-owned projection into UTF-8-safe comments. */
export function encodeRecord(
  record: CanonicalRecord,
  history: History,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
  maxCommentBytes = 65_536,
): Result<string[]> {
  const parsed = parseRecord(record)
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics }

  const projection = projectRecord(parsed.value, decodeHistory(history), config, externalHistories)
  return projection.ok ? encodeParts(parsed.value, projection.value, maxCommentBytes) : projection
}
