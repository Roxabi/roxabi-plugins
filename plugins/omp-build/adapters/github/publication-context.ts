import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { RecordProjectionConfig, Result } from '../../engine/result.ts'

/** Re-observe all semantic dependencies for the exact current publication history. */
export type PublicationContextResolver = (input: {
  record: CanonicalRecord
  history: DecodedHistory
  externalHistories: readonly DecodedHistory[]
}) => Promise<Result<{ config: RecordProjectionConfig | null; externalHistories: readonly DecodedHistory[] }>>
