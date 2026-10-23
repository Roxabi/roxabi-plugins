import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  type GitHubOptions,
  publishGitHubRecord,
  type RecordProjectionConfig,
  readGitHubHistory,
  type Scope,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from './github-policy'

export type PublishedRecord = { ok: true } | { ok: false; diagnostics: string[] }

/**
 * The one production write boundary for Roxabi producers. It always refreshes
 * history from GitHub before publishing and accepts only adapter read-back
 * confirmation; it never treats a comment write as success.
 */
export function createGitHubRecordPublisher(
  scope: Scope,
  supplied: GitHubOptions,
  config: RecordProjectionConfig | null,
): {
  publish(record: CanonicalRecord, externalHistories?: readonly DecodedHistory[]): Promise<PublishedRecord>
} {
  const options = withRoxabiGitHubPolicy(supplied)
  return {
    async publish(record, externalHistories = []): Promise<PublishedRecord> {
      if (record.repository !== scope.repository || record.target !== scope.target)
        return { ok: false, diagnostics: ['record-scope-mismatch'] }
      try {
        const history = decodeHistory(await readGitHubHistory(scope, options))
        const result = await publishGitHubRecord(record, history, options, config, externalHistories)
        if (result.status === 'confirmed') return { ok: true }
        return { ok: false, diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code) }
      } catch (error) {
        return { ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] }
      }
    },
  }
}
