import { recoveryRetiredParts } from '../../engine/fix-recovery-projection.ts'
import { looseHeaderClue, operationAuthority, withClaimedKinds } from '../../engine/history-authority.ts'
import { decodeParts, frameFrom, legacyKind, withOperationId } from '../../engine/history-framing.ts'
import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import type { ClaimedOperation, Frame, FrameFailure, UnclaimedOperation } from '../../engine/history-wire-types.ts'
import { WIRE_PREFIX } from '../../engine/history-wire-types.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { recordIntegrity } from '../../engine/record-integrity.ts'
import { projectRecord } from '../../engine/record-projection.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { RecordProjectionConfig, Result } from '../../engine/result.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { encodeParts } from './history-encoder.ts'
import { diagnostic } from './types.ts'

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
      const kind = legacyKind(comment.body)
      if (kind !== null) {
        const groups = comment.author === history.expectedAuthor ? trusted : foreign
        groups.legacy.push({
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
    if (operation.status !== 'complete' || operation.record === null) return operation
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

/** Replay confirmed controls before decoding effective membership; retain the untouched native source. */
export function projectRecoveryHistories(histories: readonly DecodedHistory[]): Result<DecodedHistory[]> {
  return projectRecoveryHistoriesForWrite(histories)
}

function projectRecoveryHistoriesForWrite(
  histories: readonly DecodedHistory[],
  prospective?: Extract<CanonicalRecord, { kind: 'fix-recovery' }>,
): Result<DecodedHistory[]> {
  if (
    prospective === undefined &&
    !histories.some((history) =>
      history.operations.some(
        (operation) =>
          operation.authority !== 'foreign' &&
          operation.status === 'complete' &&
          operation.record?.kind === 'fix-recovery',
      ),
    )
  )
    return { ok: true, value: [...histories] }
  const raw = histories.map((history) => decodeHistory(history.source))
  const retired = recoveryRetiredParts(raw, prospective)
  if (!retired.ok) return retired
  return {
    ok: true,
    value: raw.map((history) => {
      const ids = retired.value.get(scopeKey(history.source.scope))
      if (ids === undefined || ids.size === 0) return history
      const effective = decodeHistory({
        ...history.source,
        comments: history.source.comments.filter((comment) => comment.nativeId === null || !ids.has(comment.nativeId)),
      })
      return { ...effective, source: history.source }
    }),
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

  const home = decodeHistory(history)
  const scopes = new Map<string, DecodedHistory>([[scopeKey(history.scope), home]])
  for (const entry of externalHistories) {
    const key = scopeKey(entry.source.scope)
    // The fresh home read is authoritative; callers may also carry its pre-reconciliation copy.
    if (key === scopeKey(history.scope)) continue
    const previous = scopes.get(key)
    if (previous !== undefined && JSON.stringify(previous.source) !== JSON.stringify(entry.source))
      return {
        ok: false,
        diagnostics: [diagnostic('ambiguous', 'Publication history has conflicting observations for one scope')],
      }
    if (previous === undefined) scopes.set(key, entry)
  }
  const all = [...scopes.values()]
  const effective = projectRecoveryHistoriesForWrite(
    all,
    parsed.value.kind === 'fix-recovery' ? parsed.value : undefined,
  )
  if (!effective.ok) return effective
  const current = effective.value[0]
  if (current === undefined)
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Publication history is unavailable')] }
  const projection = projectRecord(parsed.value, current, config, effective.value.slice(1))
  return projection.ok ? encodeParts(parsed.value, projection.value, maxCommentBytes) : projection
}
