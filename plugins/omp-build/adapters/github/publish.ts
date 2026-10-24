import type { DecodedHistory, History, OperationRead } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { RecordProjectionConfig } from '../../engine/result.ts'
import { encodeRecord } from './history-codec.ts'
import { freshHistory, publishMissingBodies } from './publication-writer.ts'
import {
  operationConflictDiagnostics,
  type PublicationFailure,
  publicationAuthorizationDiagnostics,
  publicationFailure,
  publicationReadDiagnostics,
  retainedPartConflictDiagnostics,
  sameOperation,
} from './publisher-validation.ts'
import { diagnostic, expectedReadAuthor, type GitHubOptions, viewer } from './types.ts'

/**
 * Publish idempotently: a fresh native read decides existing parts, and every
 * successful write is accepted only after a complete native read-back.
 */
export async function publishGitHubRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  options: GitHubOptions,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<{ status: 'confirmed'; operation: OperationRead } | PublicationFailure> {
  let expectedAuthor: string
  let writer: string
  const stopAuthor = options.stopAuthor ?? null
  try {
    expectedAuthor = await expectedReadAuthor(options)
    writer = options.writerLogin ?? (await viewer(options))
  } catch (error) {
    return publicationFailure('uncertain', history, publicationReadDiagnostics(error))
  }

  const authorizationDiagnostics = publicationAuthorizationDiagnostics(
    record,
    options,
    expectedAuthor,
    writer,
    stopAuthor,
  )
  if (authorizationDiagnostics !== null) return publicationFailure('refused', history, authorizationDiagnostics)

  let current: DecodedHistory
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    return publicationFailure('uncertain', history, publicationReadDiagnostics(error))
  }

  const sameId = current.operations.filter((operation) => operation.operationId === record.operationId)
  const confirmed = sameId.find((operation) => sameOperation(record, operation))
  const incomplete = sameId.filter((operation) => operation.status === 'incomplete')
  if (confirmed !== undefined && sameId.length === 1) return { status: 'confirmed', operation: confirmed }

  const conflictDiagnostics = operationConflictDiagnostics(record, sameId, incomplete)
  if (conflictDiagnostics !== null) return publicationFailure('refused', current, conflictDiagnostics)

  const knownPartLocators = new Set(incomplete.flatMap((operation) => operation.parts.map((part) => part.locator)))
  const encodingHistory: History =
    knownPartLocators.size === 0
      ? current.source
      : {
          ...current.source,
          comments: current.source.comments.filter((comment) => !knownPartLocators.has(comment.locator)),
        }
  const encoded = encodeRecord(record, encodingHistory, config, externalHistories)
  if (!encoded.ok) return publicationFailure('refused', current, encoded.diagnostics)

  const retainedDiagnostics = retainedPartConflictDiagnostics(record, incomplete, new Set(encoded.value))
  if (retainedDiagnostics !== null) return publicationFailure('refused', current, retainedDiagnostics)

  const writeResult = await publishMissingBodies(
    record,
    encoded.value,
    current,
    options,
    expectedAuthor,
    writer,
    stopAuthor,
  )
  if (writeResult !== null) return writeResult

  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    return publicationFailure('uncertain', history, publicationReadDiagnostics(error))
  }
  const readBack = current.operations.find((operation) => sameOperation(record, operation))
  return readBack === undefined
    ? publicationFailure('uncertain', current, [
        diagnostic(
          'publication-unconfirmed',
          `Operation ${record.operationId} was not completely confirmed by native read-back`,
        ),
      ])
    : { status: 'confirmed', operation: readBack }
}
