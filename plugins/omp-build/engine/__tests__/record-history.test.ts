import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { decodeHistory, encodeRecord } from '../../adapters/github/history-codec.ts'
import { encodedAdmissionReviewGraph } from '../../testing/record-admission.ts'
import { finding, NATIVE_AUTHOR, submission, TEST_HEAD, TEST_SCOPE } from '../../testing/record-builders.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history, observedComment, operation } from '../../testing/record-history.ts'
import { classifyHistory } from '../history-classification.ts'
import { validateRecordGraph } from '../history-graph.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { projectRecord } from '../record-projection.ts'
import { validateDecision } from '../review-decision.ts'
import type { ObservedComment } from '../review-schema.ts'
import { deriveReviewState, summarizeReviews } from '../review-state.ts'
import { assessmentCodes, PROJECTION_CONFIG, refusalCodes, reviewFacts, TAXONOMY } from './record-test-support.ts'

function correctionHistorySource(comments: ObservedComment[]) {
  return {
    scope: TEST_SCOPE,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  }
}

function correctionFixtureRecords() {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/native-correction-records.json', import.meta.url), 'utf8'),
  )
  if (!Array.isArray(raw)) throw new Error('Expected correction record array')
  return raw.map((value) => {
    const parsed = parseRecord(value)
    if (!parsed.ok)
      throw new Error(`Invalid correction fixture: ${parsed.diagnostics.map(({ code }) => code).join(', ')}`)
    return parsed.value
  })
}

function correctionFrameSet(records: ReturnType<typeof correctionFixtureRecords>) {
  const comments: ObservedComment[] = []
  const locatorsByRecordId = new Map<string, Set<string>>()
  for (const record of records) {
    const encoded = encodeRecord(record, correctionHistorySource(comments), null)
    if (!encoded.ok)
      throw new Error(`Cannot encode correction fixture: ${encoded.diagnostics.map(({ code }) => code).join(', ')}`)
    const locators = new Set<string>()
    for (const body of encoded.value) {
      const id = String(comments.length + 100)
      const locator = `correction-${id}`
      locators.add(locator)
      comments.push(observedComment({ locator, nativeId: id, body, createdAt: '2026-10-21T11:00:00Z' }))
    }
    locatorsByRecordId.set(record.recordId, locators)
  }
  return { comments, locatorsByRecordId }
}

function correctionRequest(records: ReturnType<typeof correctionFixtureRecords>) {
  const request = records.find((record) => record.kind === 'fix-request')
  if (request?.kind !== 'fix-request') throw new Error('Expected correction fix request')
  return request
}

function withoutRequestFrames(
  frameSet: ReturnType<typeof correctionFrameSet>,
  request: ReturnType<typeof correctionRequest>,
) {
  const locators = frameSet.locatorsByRecordId.get(request.recordId)
  if (locators === undefined) throw new Error('Expected request frame locators')
  return frameSet.comments.filter((comment) => !locators.has(comment.locator))
}

function conflictingRequestFrames(request: ReturnType<typeof correctionRequest>, existingComments: ObservedComment[]) {
  const conflictingRequest = { ...request, operationId: 'op-conflicting-correction-request' }
  const encoded = encodeRecord(conflictingRequest, correctionHistorySource(existingComments), null)
  if (!encoded.ok)
    throw new Error(`Cannot encode conflicting request: ${encoded.diagnostics.map(({ code }) => code).join(', ')}`)
  return encoded.value.map((body, index) =>
    observedComment({
      locator: `correction-conflict-${index}`,
      nativeId: String(1000 + index),
      body,
      createdAt: '2026-10-21T11:01:00Z',
    }),
  )
}

describe('immutable admission facts', () => {
  test('refuses a cross-root review, a mismatched input, and a substituted observed review', () => {
    const left = reviewGraph({ prefix: 'left' })
    const right = reviewGraph({ prefix: 'right', empty: true })
    const crossRoot = {
      ...right.review,
      inputs: [...right.synthesis.inputs, right.root.recordId, left.decision.recordId],
      payload: { ...right.review.payload, decisionId: left.decision.recordId },
    }
    const combined = [
      ...left.records,
      ...right.records.map((record) => (record.recordId === right.review.recordId ? crossRoot : record)),
    ]
    const changedInput = deriveReviewState(
      left.history,
      { ...reviewFacts(), input: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      TAXONOMY,
    )
    const substituted = {
      ...left.review,
      payload: { ...left.review.payload, candidateGitSHA: '2222222222222222222222222222222222222222' },
    }
    const unobservedDecision = {
      ...left.decision,
      payload: { ...left.decision.payload, judgment: { ...left.decision.payload.judgment, findings: [] } },
    }

    expect(refusalCodes(validateRecordGraph(history(combined)))).toContain('unbound')
    expect(changedInput).toMatchObject({ ok: true, next: 'review' })
    expect(
      refusalCodes(projectRecord(substituted, left.history, { taxonomy: TAXONOMY, acceptedPolicy: null })),
    ).toContain('unbound')
    expect(assessmentCodes(validateDecision(unobservedDecision, left.history, TAXONOMY, null))).toContain('unbound')
  })

  test('keeps a persisted CI stop after a later green interpretation', () => {
    const green = reviewGraph({ prefix: 'persisted-green', empty: true })
    const stop = {
      ...TEST_SCOPE,
      version: 1 as const,
      recordId: 'persisted-ci-stop',
      runId: 'run-stop',
      operationId: 'op-persisted-stop',
      inputs: [green.review.recordId],
      kind: 'stop' as const,
      payload: { reason: 'ci-failed' as const, reviewId: green.review.recordId, detail: { ci: 'red' } },
    }
    const state = deriveReviewState(history([...green.records, stop]), reviewFacts(TEST_HEAD, 'green'), TAXONOMY)

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { spent: true },
      requiredStop: { reason: 'ci-failed', reviewId: 'persisted-green-final' },
    })
  })

  test('refuses slot evidence without native child/structured output and raw finding loss', () => {
    const graph = reviewGraph({ prefix: 'evidence' })
    const malformedSlot = {
      ...graph.panel,
      payload: { ...graph.panel.payload, host: { ...graph.panel.payload.host, childId: null }, structured: null },
    }
    const lostAttempt = {
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        rawAttempts: [
          submission({
            id: 'child-evidence-panel',
            structuredOutput: {
              status: 'valid',
              data: { findings: [finding({ description: 'A raw second report was dropped.' })] },
            },
          }),
        ],
      },
    }

    const malformedRecords = graph.records.map((record) =>
      record.recordId === malformedSlot.recordId ? malformedSlot : record,
    )
    const lostAttemptRecords = graph.records.map((record) =>
      record.recordId === lostAttempt.recordId ? lostAttempt : record,
    )
    expect(refusalCodes(validateRecordGraph(history(malformedRecords))).sort()).toEqual(
      expect.arrayContaining(['malformed', 'unbound']),
    )
    expect(refusalCodes(validateRecordGraph(history(lostAttemptRecords)))).toContain('unusable-finding')
  })
})
describe('history authority classification', () => {
  test('keeps accounted raw proof out of review accounting while foreign sources cannot satisfy authority', () => {
    const graph = reviewGraph({ prefix: 'classified', empty: true })
    const proof = {
      ...TEST_SCOPE,
      version: 1 as const,
      recordId: 'classified-proof',
      runId: 'run-classified',
      operationId: 'op-classified-proof',
      inputs: [],
      kind: 'proof' as const,
      payload: { candidateGitSHA: TEST_HEAD, data: { transport: 'opaque' } },
    }
    const accounted = history([...graph.records, proof], {
      operations: [...graph.history.operations, operation(proof, { authority: 'accounted' })],
    })
    const classification = classifyHistory(accounted)

    expect(classification.authorityHistory.source).toBe(accounted.source)
    expect(classification.classes.find((entry) => entry.operationId === proof.operationId)).toMatchObject({
      authority: 'accounted',
    })
    expect(classification.authorityHistory.operations.some((entry) => entry.recordId === proof.recordId)).toBe(false)
    expect(summarizeReviews(accounted, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { verdict: 'Approve (clean)', reviews: 1 },
    })

    const foreignPanel = history(graph.records, {
      operations: graph.history.operations.map((entry) =>
        entry.recordId === graph.panel.recordId ? { ...entry, authority: 'foreign' as const } : entry,
      ),
    })
    expect(
      classifyHistory(foreignPanel).authorityHistory.operations.some(
        (entry) => entry.recordId === graph.panel.recordId,
      ),
    ).toBe(false)
    expect(
      validateDecision(graph.decision, classifyHistory(foreignPanel).authorityHistory, TAXONOMY, null),
    ).toMatchObject({ admissible: false })
  })

  test('promotes an accounted dependency of an authority review root but refuses foreign or missing dependencies', () => {
    const graph = reviewGraph({ prefix: 'root-proof', empty: true })
    const proofResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'root-proof-evidence',
        runId: 'root-proof-run',
        operationId: 'op-root-proof-evidence',
        kind: 'proof' as const,
        payload: { candidateGitSHA: TEST_HEAD, data: { origin: 'accounted-context' } },
      } as never,
      [],
    )
    if (!proofResult.ok || proofResult.value.kind !== 'proof') throw new Error('Expected accounted proof')
    const root = { ...graph.root, inputs: [proofResult.value.recordId] }
    const records = [
      proofResult.value,
      ...graph.records.map((record) => (record.recordId === root.recordId ? root : record)),
    ]
    const recorded = history(records)
    const accounted = {
      ...recorded,
      operations: recorded.operations.map((entry) =>
        entry.recordId === proofResult.value.recordId ? { ...entry, authority: 'accounted' as const } : entry,
      ),
    }
    const foreign = {
      ...recorded,
      operations: recorded.operations.map((entry) =>
        entry.recordId === proofResult.value.recordId ? { ...entry, authority: 'foreign' as const } : entry,
      ),
    }
    const missing = history(graph.records.map((record) => (record.recordId === root.recordId ? root : record)))

    expect(summarizeReviews(accounted, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)' },
    })
    expect(
      classifyHistory(accounted).authorityHistory.operations.some(
        (entry) => entry.recordId === proofResult.value.recordId,
      ),
    ).toBe(true)
    expect(summarizeReviews(foreign, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(missing, TAXONOMY, null).ok).toBe(false)
  })

  test('keeps a complete independent accounted correction graph out of green review accounting', () => {
    const correction = correctionFixtureRecords()
    const frameSet = correctionFrameSet(correction)
    const green = encodedAdmissionReviewGraph(PROJECTION_CONFIG, {
      prefix: 'green-with-correction',
      verdict: 'Approve (clean)',
    })
    const mixed = decodeHistory(correctionHistorySource([...green.comments, ...frameSet.comments]))
    const request = correctionRequest(correction)
    const requestFreeComments = withoutRequestFrames(frameSet, request)
    const withoutRequest = decodeHistory(correctionHistorySource([...green.comments, ...requestFreeComments]))
    const conflictingComments = conflictingRequestFrames(request, requestFreeComments)
    const ambiguous = decodeHistory(
      correctionHistorySource([...green.comments, ...frameSet.comments, ...conflictingComments]),
    )
    expect(withoutRequest.operations.some((entry) => entry.recordId === request.recordId)).toBe(false)
    expect(ambiguous.operations.filter((entry) => entry.recordId === request.recordId).length).toBe(2)

    expect(summarizeReviews(mixed, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)' },
    })
    expect(summarizeReviews(withoutRequest, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(ambiguous, TAXONOMY, null).ok).toBe(false)
  })

  test('keeps trusted unknown and incomplete final operations authoritative and refusing', () => {
    const graph = reviewGraph({ prefix: 'authority-refusal', empty: true })
    const unknown = operation(graph.review, {
      operationId: 'trusted-unknown',
      recordId: null,
      kind: 'trusted-unknown',
      claimedKinds: ['trusted-unknown'],
      record: null,
      parts: [],
    })
    const unknownHistory = history(graph.records, { operations: [...graph.history.operations, unknown] })
    const incompleteFinal = history(graph.records, {
      operations: graph.history.operations.map((entry) =>
        entry.recordId === graph.review.recordId ? { ...entry, status: 'incomplete' as const } : entry,
      ),
    })

    expect(classifyHistory(unknownHistory).classes[classifyHistory(unknownHistory).classes.length - 1]).toMatchObject({
      operationId: 'trusted-unknown',
      authority: 'authority',
    })
    expect(summarizeReviews(unknownHistory, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(incompleteFinal, TAXONOMY, null).ok).toBe(false)
  })

  test('refuses an operation whose runtime authority stamp is absent', () => {
    const graph = reviewGraph({ prefix: 'missing-authority', empty: true })
    const stamped = history(graph.records)
    const [first, ...remaining] = stamped.operations
    if (first === undefined) throw new Error('Expected an observed operation')
    const { authority: _authority, ...withoutAuthority } = first
    const unstamped = { ...stamped, operations: [withoutAuthority as typeof first, ...remaining] }
    const classified = classifyHistory(unstamped)

    expect(classified.authorityHistory.diagnostics.map(({ code }) => code)).toContain('unclassified')
    expect(summarizeReviews(unstamped, TAXONOMY, null).ok).toBe(false)
  })
})
