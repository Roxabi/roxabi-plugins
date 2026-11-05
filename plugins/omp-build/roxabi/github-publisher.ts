import {
  type CanonicalRecord,
  type DecodedHistory,
  type GitHubOptions,
  publishGitHubRecord,
  type Scope,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createPublicationContextResolver } from './publication-context.ts'

export type PublishedRecord = { ok: true } | { ok: false; diagnostics: string[] }

async function publishChecked(
  options: GitHubOptions,
  acceptedPolicy: string | null,
  record: CanonicalRecord,
  externalHistories: readonly DecodedHistory[],
  canPublish?: () => boolean,
): Promise<PublishedRecord> {
  if (canPublish?.() === false) return { ok: false, diagnostics: ['publication-ownership-revoked'] }
  const result = await publishGitHubRecord(
    record,
    canPublish === undefined ? options : { ...options, canPublish },
    createPublicationContextResolver(options, acceptedPolicy),
    externalHistories,
  )
  if (canPublish?.() === false) return { ok: false, diagnostics: ['publication-ownership-revoked'] }
  if (result.status === 'confirmed') return { ok: true }
  return { ok: false, diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code) }
}

/**
 * The one production write boundary for Roxabi producers. It always refreshes
 * history from GitHub before publishing and accepts only adapter read-back
 * confirmation; it never treats a comment write as success.
 */
export function createGitHubRecordPublisher(
  scope: Scope,
  supplied: GitHubOptions,
  acceptedPolicy: string | null,
): {
  publish(
    record: CanonicalRecord,
    externalHistories?: readonly DecodedHistory[],
    canPublish?: () => boolean,
  ): Promise<PublishedRecord>
} {
  const options = withRoxabiGitHubPolicy(supplied)
  return {
    async publish(record, externalHistories = [], canPublish): Promise<PublishedRecord> {
      if (record.repository !== scope.repository || record.target !== scope.target)
        return { ok: false, diagnostics: ['record-scope-mismatch'] }
      try {
        return await publishChecked(options, acceptedPolicy, record, externalHistories, canPublish)
      } catch (error) {
        return { ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] }
      }
    },
  }
}
