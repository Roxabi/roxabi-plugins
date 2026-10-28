import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { projectRecord } from '../../engine/record-projection.ts'
import { isWorkflowKind } from '../../engine/record-references.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { RecordProjectionConfig, Result } from '../../engine/result.ts'
import { looseHeaderClue, operationAuthority, withClaimedKinds } from './history-authority.ts'
import { encodeParts } from './history-encoder.ts'
import { decodeParts, frameFrom, legacyKind, withOperationId } from './history-framing.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { ClaimedOperation, Frame, FrameFailure, UnclaimedOperation } from './types.ts'
import { diagnostic, WIRE_PREFIX } from './types.ts'

type FrameGroups = {
  framed: Map<string, Frame[]>
  invalidFrames: Map<string, FrameFailure[]>
  legacy: UnclaimedOperation[]
}

function frameGroups(): FrameGroups {
  return { framed: new Map(), invalidFrames: new Map(), legacy: [] }
}

function trustedFrame(
  history: History,
  comment: History['comments'][number],
  frame: Frame | FrameFailure | null,
): boolean {
  if (comment.author === history.expectedAuthor) return true
  return (
    history.stopAuthor !== null &&
    comment.author === history.stopAuthor &&
    frame !== null &&
    !('diagnostic' in frame) &&
    frame.kind === 'stop'
  )
}

function addFrame(groups: FrameGroups, frame: Frame | FrameFailure): void {
  if ('diagnostic' in frame) {
    const key =
      frame.operationId === null
        ? `invalid:${frame.comment.locator}`
        : `invalid:${JSON.stringify([frame.operationId, frame.recordId, frame.kind])}`
    const entries = groups.invalidFrames.get(key) ?? []
    entries.push(frame)
    groups.invalidFrames.set(key, entries)
    return
  }
  const entries = groups.framed.get(frame.operationId) ?? []
  entries.push(frame)
  groups.framed.set(frame.operationId, entries)
}

function collectFrameGroups(history: History) {
  const trusted = frameGroups()
  const foreign = frameGroups()
  const trustedComments: History['comments'] = []
  for (const comment of history.comments) {
    const frame = frameFrom(comment)
    if (frame === null) {
      if (comment.author === history.expectedAuthor) {
        const kind = legacyKind(comment.body)
        if (kind !== null)
          trusted.legacy.push({
            operationId: null,
            recordId: null,
            kind,
            status: 'legacy',
            parts: [comment],
            record: null,
          })
      }
      continue
    }
    const accepted = trustedFrame(history, comment, frame)
    if (accepted) trustedComments.push(comment)
    addFrame(accepted ? trusted : foreign, frame)
  }
  return { trusted, foreign, trustedComments }
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

function decodedOperations(history: History, groups: FrameGroups) {
  const invalid = decodedInvalidOperations(groups.invalidFrames)
  const decoded = decodedFramedOperations(history, groups.framed)
  return {
    operations: [...invalid.operations, ...decoded.operations, ...groups.legacy],
    diagnostics: [...invalid.diagnostics, ...decoded.diagnostics, ...legacyDiagnostics(groups.legacy)],
  }
}

function immutableTrustedWorkflowOperations(decoded: ReturnType<typeof decodedOperations>) {
  const diagnostics: Diagnostic[] = []
  const operations = decoded.operations.map((operation) => {
    if (operation.status !== 'complete' || operation.record === null || !isWorkflowKind(operation.record.kind))
      return operation
    const refusal =
      operation.parts.length === 0
        ? {
            reason: 'record-unreadable' as const,
            detail: `${operation.record.kind} record ${operation.record.recordId} has no native parts`,
          }
        : recordIntegrity(operation.parts, operation.record)
    if (refusal === null) return operation
    diagnostics.push(...withOperationId([diagnostic(refusal.reason, refusal.detail)], operation.operationId))
    return { ...operation, status: 'invalid' as const, record: null }
  })
  return { operations, diagnostics: [...decoded.diagnostics, ...diagnostics] }
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
  const { trusted, foreign, trustedComments } = collectFrameGroups(history)
  const trustedDecoded = immutableTrustedWorkflowOperations(decodedOperations(history, trusted))
  const foreignDecoded = decodedOperations(history, foreign)
  const clues = trustedComments.filter((comment) => comment.body.startsWith(WIRE_PREFIX)).map(looseHeaderClue)
  const authority = (operation: UnclaimedOperation) => {
    const claimed: ClaimedOperation = withClaimedKinds(operation)
    return { ...claimed, authority: operationAuthority(claimed, history, clues) }
  }
  return {
    source: history,
    operations: [
      ...trustedDecoded.operations.map(authority),
      ...foreignDecoded.operations.map((operation) => ({
        ...withClaimedKinds(operation),
        authority: 'foreign' as const,
      })),
    ],
    diagnostics: trustedDecoded.diagnostics,
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
