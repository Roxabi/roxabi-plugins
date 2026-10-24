import { decodeHistory, encodeRecord, githubScope, type History } from '../../../../dist/contracts.js'
import type { Producer } from '../../proof-base'
import { findProofRecord, newProofRecord } from '../../proof-records'

const fixtureHistory = (repository: string, pr: number, comments: string[] = []): History => ({
  scope: githubScope(repository, pr),
  expectedAuthor: 'operator',
  stopAuthor: null,
  complete: true,
  comments: comments.map((body, index) => ({
    locator: `${repository}#${pr}:fixture:${index + 1}`,
    nativeId: String(index + 1),
    body,
    author: 'operator',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })),
  diagnostics: [],
})

/** Shared-codec comments around byte-for-byte retained native proof data. */
export function proofComments(
  producer: Producer,
  candidate: string,
  data: unknown,
  pr: number,
  repository = 'acme/app',
): string[] {
  const encoded = encodeRecord(
    newProofRecord(repository, pr, producer, candidate, data),
    fixtureHistory(repository, pr),
    null,
  )
  if (!encoded.ok) throw new Error(encoded.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  return encoded.value
}

/** Decode test comments through the same public codec path as proof admission. */
export function proofData(
  producer: Producer,
  candidate: string,
  comments: string[],
  pr: number,
  repository = 'acme/app',
): unknown {
  const found = findProofRecord(decodeHistory(fixtureHistory(repository, pr, comments)), producer, candidate)
  if (!('record' in found)) throw new Error('the common proof record did not decode')
  return found.record
}
