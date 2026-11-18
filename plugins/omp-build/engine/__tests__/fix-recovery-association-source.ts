import { createHash } from 'node:crypto'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { capturedSubmission } from '../../roxabi/fix-contract.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import type { ObservedComment } from '../review-schema.ts'
import type { OwnSpecRef } from '../uw-spec-schema.ts'

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

/** Frame canonical fixture records while preserving unique native comment identities. */
export function associationFrames() {
  const date = '2026-10-27T12:00:00Z'
  let serial = 90000
  return (record: CanonicalRecord) => {
    const bodies = must(encodeParts(record, '', 65536))
    return bodies.map((body, index) => {
      const nativeId = String(serial++)
      const comment: ObservedComment = {
        locator: `association-${nativeId}`,
        nativeId,
        author: 'operator',
        body,
        createdAt: date,
        updatedAt: date,
      }
      return {
        comment,
        pin: {
          locator: comment.locator,
          nativeId,
          author: comment.author,
          createdAt: date,
          updatedAt: date,
          bodyDigest: createHash('sha256').update(body).digest('hex'),
          part: index + 1,
          total: bodies.length,
        },
      }
    })
  }
}

/** Canonical source and request records for the structural recovery fixture. */
export function associationSource(input: {
  pullRequest: Scope
  sourceId: { recordId: string; operationId: string }
  requestId: { recordId: string; operationId: string }
  runId: string
  head: string
  ownSpec: OwnSpecRef
}) {
  const { pullRequest, sourceId, requestId, runId, head, ownSpec } = input
  const source = must(
    buildRecord({
      ...pullRequest,
      version: 1,
      kind: 'contribution',
      recordId: sourceId.recordId,
      runId,
      operationId: sourceId.operationId,
      payload: {
        content: 'operator-request',
        inventoryId: null,
        host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
        rawAttempts: [
          capturedSubmission({
            operatorRequest: { request: 'Correct the review findings' },
            candidateGitSHA: head,
            publishBinding: {
              publicationRepository: pullRequest.repository,
              localBranch: 'feat/42-save',
              destinationRef: 'refs/heads/feat/42-save',
              localHead: head,
              expectedRemoteSHA: head,
              observed: {
                target: pullRequest.target,
                baseRepository: pullRequest.repository,
                localRef: 'refs/heads/feat/42-save',
                localHead: head,
                remoteRepository: pullRequest.repository,
                pr: {
                  headRefOid: head,
                  headRefName: 'feat/42-save',
                  baseRefName: 'main',
                  headRepository: pullRequest.repository,
                },
              },
            },
          }),
        ],
        native: null,
        structured: null,
        findings: null,
      },
    }),
  )
  const request = (review: string | null) =>
    must(
      buildRecord({
        ...pullRequest,
        version: 1,
        kind: 'fix-request',
        recordId: requestId.recordId,
        runId,
        operationId: requestId.operationId,
        payload: {
          requestContributionId: source.recordId,
          originalSpec: ownSpec,
          existingReviewId: review,
          scope: 'all findings',
          landing: false,
        },
      }),
    )
  return { source, request }
}
