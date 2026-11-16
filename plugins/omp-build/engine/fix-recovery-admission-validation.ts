import { canonicalValueDigest } from './action-input.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import { recoveryRetiredParts } from './fix-recovery-projection.ts'
import { frameFrom } from './history-framing.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
export const scopeId = (scope: Scope) => JSON.stringify([scope.repository, scope.target])
type Operation = DecodedHistory['operations'][number]

function validatePart(raw: DecodedHistory, operation: Operation, part: Operation['parts'][number]): Result<void> {
  if (operation.status === 'legacy') {
    if (
      raw.source.comments.filter((comment) => canonicalValueDigest(comment) === canonicalValueDigest(part)).length !== 1
    )
      return fail('Legacy history part differs from the native source')
    return { ok: true, value: undefined }
  }
  const frame = frameFrom(part)
  if (
    frame === null ||
    'diagnostic' in frame ||
    frame.operationId !== operation.operationId ||
    frame.recordId !== operation.recordId ||
    frame.kind !== operation.kind ||
    (part.author !== raw.source.expectedAuthor && part.author !== raw.source.stopAuthor)
  )
    return fail('Owner admission found a mismatched native operation identity')
  const pin = commentAsPartPin(part)
  if (
    pin === null ||
    raw.source.comments.filter((comment) => {
      const actual = commentAsPartPin(comment)
      return actual !== null && partPinsEqual(pin, actual)
    }).length !== 1
  )
    return fail('Owner admission found an unpinnable or changed native part')
  return { ok: true, value: undefined }
}

function validateOperation(raw: DecodedHistory, operation: Operation, excluded: ReadonlySet<string>): Result<void> {
  const retiredCount = operation.parts.filter((part) => part.nativeId !== null && excluded.has(part.nativeId)).length
  if (retiredCount !== 0 && retiredCount !== operation.parts.length)
    return fail('Recovery cut split one native operation')
  if (operation.authority === 'foreign') return { ok: true, value: undefined }
  if (
    operation.status === 'complete' &&
    (operation.record === null ||
      !equalScope(operation.record, raw.source.scope) ||
      operation.record.operationId !== operation.operationId ||
      operation.record.recordId !== operation.recordId ||
      operation.record.kind !== operation.kind ||
      recordIntegrity(operation.parts, operation.record) !== null)
  )
    return fail('Owner admission found a changed complete envelope')
  for (const part of operation.parts) {
    const result = validatePart(raw, operation, part)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}

function validateTrustedComments(raw: DecodedHistory): Result<void> {
  for (const comment of raw.source.comments) {
    if (comment.author !== raw.source.expectedAuthor && comment.author !== raw.source.stopAuthor) continue
    const frame = frameFrom(comment)
    if (frame === null) continue
    if ('diagnostic' in frame || comment.nativeId === null)
      return fail('Owner admission found malformed trusted framing')
    const claimed = raw.operations.filter((operation) =>
      operation.parts.some((part) => part.nativeId === comment.nativeId),
    )
    if (claimed.length !== 1) return fail('Owner admission found unaccounted trusted native framing')
  }
  return { ok: true, value: undefined }
}

function validateEffective(raw: DecodedHistory, history: DecodedHistory, excluded: ReadonlySet<string>): Result<void> {
  const kept = raw.operations.filter((operation) => {
    const parts = operation.parts.filter((part) => part.nativeId !== null && excluded.has(part.nativeId))
    return parts.length !== operation.parts.length || parts.length === 0
  })
  if (canonicalValueDigest(kept) !== canonicalValueDigest(history.operations))
    return fail('Effective history differs from the authenticated finite control cut')
  for (const operation of raw.operations) {
    const result = validateOperation(raw, operation, excluded)
    if (!result.ok) return result
  }
  return validateTrustedComments(raw)
}

export function validateAdmissionHistories(
  histories: readonly DecodedHistory[],
  effectiveHistories: readonly DecodedHistory[],
  uw: Scope,
  pullRequest: Scope,
): Result<{ homes: Map<string, DecodedHistory>; effective: Map<string, DecodedHistory> }> {
  const homes = new Map<string, DecodedHistory>()
  for (const history of histories) {
    const key = scopeId(history.source.scope)
    if (homes.has(key) || !history.source.complete || history.source.diagnostics.length !== 0)
      return fail('Owner admission requires unique complete native source observations')
    homes.set(key, history)
  }
  if (!homes.has(scopeId(uw)) || !homes.has(scopeId(pullRequest)) || effectiveHistories.length !== homes.size)
    return fail('Owner admission is missing a required UW or pull-request history')
  const retired = recoveryRetiredParts(histories)
  if (!retired.ok) return retired
  const effective = new Map<string, DecodedHistory>()
  for (const history of effectiveHistories) {
    const key = scopeId(history.source.scope)
    const raw = homes.get(key)
    if (
      raw === undefined ||
      effective.has(key) ||
      canonicalValueDigest(raw.source) !== canonicalValueDigest(history.source)
    )
      return fail('Effective history does not preserve the exact observed native source')
    const excluded =
      retired.value.get(`${history.source.scope.repository}\0${history.source.scope.target}`) ?? new Set<string>()
    const result = validateEffective(raw, history, excluded)
    if (!result.ok) return result
    effective.set(key, history)
  }
  return { ok: true, value: { homes, effective } }
}

function validateHistoryDiagnostics(
  history: DecodedHistory,
  intent: 'fresh' | 'recovery' | 'claim',
  allowed: ReadonlySet<string>,
): Result<void> {
  for (const operation of history.operations) {
    if (operation.authority === 'foreign' || operation.status === 'complete' || operation.status === 'legacy') continue
    if (
      intent !== 'recovery' ||
      operation.status !== 'incomplete' ||
      operation.operationId === null ||
      !allowed.has(`${scopeId(history.source.scope)}\0${operation.operationId}`)
    )
      return fail('Owner admission found an unrelated incomplete or ambiguous operation')
  }
  for (const entry of history.diagnostics) {
    if (
      intent !== 'recovery' ||
      entry.code !== 'incomplete' ||
      entry.operationId === undefined ||
      !allowed.has(`${scopeId(history.source.scope)}\0${entry.operationId}`)
    )
      return fail('Owner admission retains a blocking history diagnostic')
  }
  return { ok: true, value: undefined }
}

export function validateAdmissionDiagnostics(
  effective: Iterable<DecodedHistory>,
  intent: 'fresh' | 'recovery' | 'claim',
  allowed: ReadonlySet<string>,
): Result<void> {
  for (const history of effective) {
    const result = validateHistoryDiagnostics(history, intent, allowed)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}
