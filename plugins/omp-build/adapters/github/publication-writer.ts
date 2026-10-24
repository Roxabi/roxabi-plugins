import type { DecodedHistory, OperationRead } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { ObservedComment } from '../../engine/review-schema.ts'
import { decodeHistory } from './history-codec.ts'
import {
  type PublicationFailure,
  publicationFailure,
  publicationReadDiagnostics,
  sameOperation,
} from './publisher-validation.ts'
import { readWithAuthor } from './transport.ts'
import { diagnostic, type GitHubOptions, gh, parseComment, targetNumber } from './types.ts'

export type PublicationWriteResult = { status: 'confirmed'; operation: OperationRead } | PublicationFailure | null

export async function freshHistory(
  record: CanonicalRecord,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
): Promise<DecodedHistory> {
  return decodeHistory(await readWithAuthor(record, options, expectedAuthor, stopAuthor))
}

async function postComment(record: CanonicalRecord, body: string, options: GitHubOptions): Promise<string> {
  return gh(options)(options.cwd, [
    'api',
    '--method',
    'POST',
    `repos/${record.repository}/issues/${targetNumber(record)}/comments`,
    '-f',
    `body=${body}`,
  ])
}

function parsePostedComment(
  response: string,
  record: CanonicalRecord,
  current: DecodedHistory,
): ObservedComment | PublicationFailure {
  try {
    return parseComment(JSON.parse(response), record, 0, 0)
  } catch (error) {
    return publicationFailure('uncertain', current, [
      diagnostic('invalid-github-response', error instanceof Error ? error.message : String(error)),
    ])
  }
}

async function reconcileFailedPost(
  record: CanonicalRecord,
  current: DecodedHistory,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
  error: unknown,
): Promise<PublicationWriteResult> {
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (readError) {
    return publicationFailure('uncertain', current, publicationReadDiagnostics(readError))
  }
  const afterFailure = current.operations.find((operation) => sameOperation(record, operation))
  if (afterFailure !== undefined) return { status: 'confirmed', operation: afterFailure }
  return publicationFailure('uncertain', current, [
    diagnostic('github-write-uncertain', error instanceof Error ? error.message : String(error)),
  ])
}

async function rejectUnexpectedWriter(
  record: CanonicalRecord,
  current: DecodedHistory,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
  posted: ObservedComment,
  writer: string,
): Promise<PublicationFailure> {
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (readError) {
    return publicationFailure('uncertain', current, publicationReadDiagnostics(readError))
  }
  return publicationFailure('uncertain', current, [
    diagnostic('native-author-mismatch', `GitHub POST response writer ${posted.author ?? 'unknown'} is not ${writer}`),
  ])
}

export async function publishMissingBodies(
  record: CanonicalRecord,
  bodies: readonly string[],
  current: DecodedHistory,
  options: GitHubOptions,
  expectedAuthor: string,
  writer: string,
  stopAuthor: string | null,
): Promise<PublicationWriteResult> {
  const existingBodies = new Set(current.source.comments.map((comment) => comment.body))
  for (const body of bodies) {
    if (existingBodies.has(body)) continue
    let response: string
    try {
      response = await postComment(record, body, options)
    } catch (error) {
      return reconcileFailedPost(record, current, options, expectedAuthor, stopAuthor, error)
    }
    const posted = parsePostedComment(response, record, current)
    if ('status' in posted) return posted
    if (posted.nativeId === null || posted.author !== writer) {
      return rejectUnexpectedWriter(record, current, options, expectedAuthor, stopAuthor, posted, writer)
    }
  }
  return null
}
