import { encodeParts } from '../adapters/github/history-encoder.ts'
import type { DecodedHistory, OperationRead } from '../engine/history-schema.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import { observeFixtureCatalogue } from './action-input-fixtures.ts'
import { NATIVE_AUTHOR, TEST_SCOPE } from './record-builders.ts'

/** Seed immutable history bytes without authorizing a new publication. */
export function historicalRecordFrames(record: CanonicalRecord, projection = ''): string[] {
  const canonical = parseRecord(record)
  if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics))
  const encoded = encodeParts(canonical.value, projection, 65_536)
  if (!encoded.ok) throw new Error(JSON.stringify(encoded.diagnostics))
  return encoded.value
}

export function observedComment(overrides: Partial<ObservedComment> = {}): ObservedComment {
  const createdAt = overrides.createdAt ?? '2026-10-21T10:00:00Z'
  return {
    locator: 'comment-101',
    nativeId: '101',
    body: '<!-- omp-build:record v=1 kind=review record=final-review operation=op-final-review part=1 total=1 -->',
    author: NATIVE_AUTHOR,
    ...overrides,
    createdAt,
    updatedAt: overrides.updatedAt !== undefined ? overrides.updatedAt : createdAt,
  }
}

export function operation(record: CanonicalRecord, overrides: Partial<OperationRead> = {}): OperationRead {
  return {
    operationId: record.operationId,
    recordId: record.recordId,
    kind: record.kind,
    status: 'complete',
    authority: 'authority',
    claimedKinds: [record.kind],
    parts: [observedComment({ locator: `comment-${record.recordId}` })],
    record,
    ...overrides,
  }
}

export function history(records: CanonicalRecord[], overrides: Partial<DecodedHistory> = {}): DecodedHistory {
  return observeFixtureCatalogue({
    source: {
      scope: TEST_SCOPE,
      expectedAuthor: NATIVE_AUTHOR,
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: records.map((record) => operation(record)),
    diagnostics: [],
    ...overrides,
  })
}
