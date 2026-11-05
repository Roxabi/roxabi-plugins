import { observedComment, operation as observedOperation } from '../../testing/record-history.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'

export function ref<K extends CanonicalRecord>(record: K): { scope: Scope; recordId: string; kind: K['kind'] } {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

export function appendAccountedRecords(baseline: DecodedHistory, records: CanonicalRecord[]): DecodedHistory {
  return {
    ...baseline,
    operations: [
      ...baseline.operations,
      ...records.map((record) =>
        observedOperation(record, {
          authority: 'accounted',
          parts: [
            observedComment({ author: 'operator', locator: `comment-${record.recordId}`, nativeId: record.recordId }),
          ],
        }),
      ),
    ],
  }
}
