import type { DecodedHistory, History, OperationRead } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { encodeRecord } from './history-codec.ts'
import type { PublicationContextResolver } from './publication-context.ts'
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

async function confirmReadBack(
  record: CanonicalRecord,
  current: DecodedHistory,
  resolveContext: PublicationContextResolver,
  externalHistories: readonly DecodedHistory[],
): Promise<{ status: 'confirmed'; operation: OperationRead } | PublicationFailure> {
  const readBack = current.operations.find((operation) => sameOperation(record, operation))
  if (readBack === undefined)
    return publicationFailure('uncertain', current, [
      diagnostic(
        'publication-unconfirmed',
        `Operation ${record.operationId} was not completely confirmed by native read-back`,
      ),
    ])
  try {
    const latest = await resolveContext({ record, history: current, externalHistories })
    if (!latest.ok) return publicationFailure('uncertain', current, latest.diagnostics)
    const ownLocators = new Set(readBack.parts.map((part) => part.locator))
    const beforeRecord: History = {
      ...current.source,
      comments: current.source.comments.filter((comment) => !ownLocators.has(comment.locator)),
    }
    const checked = encodeRecord(record, beforeRecord, latest.value.config, latest.value.externalHistories)
    if (!checked.ok) return publicationFailure('uncertain', current, checked.diagnostics)
  } catch (error) {
    return publicationFailure('uncertain', current, publicationReadDiagnostics(error))
  }
  return { status: 'confirmed', operation: readBack }
}

async function confirmPublicationWrite(
  record: CanonicalRecord,
  current: DecodedHistory,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
  resolveContext: PublicationContextResolver,
  externalHistories: readonly DecodedHistory[],
  writeResult: Awaited<ReturnType<typeof publishMissingBodies>>,
): Promise<{ status: 'confirmed'; operation: OperationRead } | PublicationFailure> {
  if (writeResult?.status === 'recovered')
    return confirmReadBack(record, writeResult.history, resolveContext, externalHistories)
  if (writeResult !== null) return writeResult
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    return publicationFailure('uncertain', current, publicationReadDiagnostics(error))
  }
  return confirmReadBack(record, current, resolveContext, externalHistories)
}

async function encodePublication(
  record: CanonicalRecord,
  current: DecodedHistory,
  ownParts: readonly OperationRead[],
  resolveContext: PublicationContextResolver,
  externalHistories: readonly DecodedHistory[],
): Promise<{ status: 'ready'; bodies: string[] } | PublicationFailure> {
  let resolved: Awaited<ReturnType<PublicationContextResolver>>
  try {
    resolved = await resolveContext({ record, history: current, externalHistories })
  } catch (error) {
    return publicationFailure('uncertain', current, publicationReadDiagnostics(error))
  }
  if (!resolved.ok) return publicationFailure('refused', current, resolved.diagnostics)
  const knownPartLocators = new Set(ownParts.flatMap((operation) => operation.parts.map((part) => part.locator)))
  const encodingHistory: History =
    knownPartLocators.size === 0
      ? current.source
      : {
          ...current.source,
          comments: current.source.comments.filter((comment) => !knownPartLocators.has(comment.locator)),
        }
  const encoded = encodeRecord(record, encodingHistory, resolved.value.config, resolved.value.externalHistories)
  return encoded.ok
    ? { status: 'ready', bodies: encoded.value }
    : publicationFailure('refused', current, encoded.diagnostics)
}

/**
 * Publish idempotently: a fresh native read decides existing parts, and every
 * successful write is accepted only after a complete native read-back.
 */
export async function publishGitHubRecord(
  record: CanonicalRecord,
  options: GitHubOptions,
  resolveContext: PublicationContextResolver,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<{ status: 'confirmed'; operation: OperationRead } | PublicationFailure> {
  let expectedAuthor: string
  let writer: string
  const stopAuthor = options.stopAuthor ?? null
  try {
    expectedAuthor = await expectedReadAuthor(options)
    writer = options.writerLogin ?? (await viewer(options))
  } catch (error) {
    return publicationFailure('uncertain', null, publicationReadDiagnostics(error))
  }

  const authorizationDiagnostics = publicationAuthorizationDiagnostics(
    record,
    options,
    expectedAuthor,
    writer,
    stopAuthor,
  )
  if (authorizationDiagnostics !== null) return publicationFailure('refused', null, authorizationDiagnostics)

  let current: DecodedHistory
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    return publicationFailure('uncertain', null, publicationReadDiagnostics(error))
  }

  const sameId = current.operations.filter(
    (operation) => operation.authority !== 'foreign' && operation.operationId === record.operationId,
  )
  const confirmed = sameId.find((operation) => sameOperation(record, operation))
  const incomplete = sameId.filter((operation) => operation.status === 'incomplete')

  const conflictDiagnostics =
    confirmed !== undefined && sameId.length === 1 ? null : operationConflictDiagnostics(record, sameId, incomplete)
  if (conflictDiagnostics !== null) return publicationFailure('refused', current, conflictDiagnostics)

  const ownParts = confirmed === undefined ? incomplete : [...incomplete, confirmed]
  const encoded = await encodePublication(record, current, ownParts, resolveContext, externalHistories)
  if (encoded.status !== 'ready') return encoded
  if (confirmed !== undefined && sameId.length === 1) return { status: 'confirmed', operation: confirmed }

  const retainedDiagnostics = retainedPartConflictDiagnostics(record, incomplete, new Set(encoded.bodies))
  if (retainedDiagnostics !== null) return publicationFailure('refused', current, retainedDiagnostics)

  const writeResult = await publishMissingBodies(
    record,
    encoded.bodies,
    current,
    options,
    expectedAuthor,
    writer,
    stopAuthor,
  )
  return confirmPublicationWrite(
    record,
    current,
    options,
    expectedAuthor,
    stopAuthor,
    resolveContext,
    externalHistories,
    writeResult,
  )
}
