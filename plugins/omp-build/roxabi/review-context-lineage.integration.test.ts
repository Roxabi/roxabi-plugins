import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { MissingContextOutput } from '../engine/action-context.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { reviewContextLineage } from '../engine/review-context-lineage.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, reviewRoot, submission, TEST_SCOPE } from '../testing/record-builders.ts'
import { contribution, finalReview } from '../testing/record-decisions.ts'
import { historicalRecordFrames, observedComment } from '../testing/record-history.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
const negative: MissingContextOutput = {
  outcome: 'missing-context',
  missing: [
    { locator: { kind: 'information-request', description: 'deployment region' }, reason: 'not supplied', targets: [] },
  ],
}

function history(records: CanonicalRecord[]) {
  const comments = records.flatMap((record) =>
    historicalRecordFrames(record).map((body) =>
      observedComment({ locator: `comment-${record.recordId}`, nativeId: record.recordId, body }),
    ),
  )
  return decodeHistory({
    scope: TEST_SCOPE,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments,
  })
}

function expanded(inputs: ActionInputs, entry: Contribution, path: string): ActionInputs {
  const manifest = {
    ...inputs.manifest,
    expandedContext: [
      ...inputs.manifest.expandedContext,
      {
        source: 'record' as const,
        record: { scope: TEST_SCOPE, kind: 'contribution' as const, recordId: entry.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(entry.payload),
      },
      {
        source: 'git-file' as const,
        repository: TEST_SCOPE.repository,
        commit: 'b'.repeat(40),
        path,
        digest: canonicalValueDigest(path),
      },
    ],
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

function historicalReview(inputs: ActionInputs, id: string, data: typeof negative | { findings: never[] }) {
  const slotId = 'panel-0'
  const action = { actionId: `${id}:${slotId}`, inputs }
  const root = reviewRoot({
    id: `review-${id}`,
    head: inputs.manifest.code.head,
    inputSnapshot: inputs,
    tier: 'F-lite',
    slots: [
      {
        slotId,
        phase: 'panel',
        role: 'R-adversarial',
        chunk: 0,
        required: true,
        output: 'findings',
        classId: null,
        sourceFindingIds: [],
        action,
      },
    ],
  })
  const entry = contribution({
    id: `contribution-${id}`,
    inventoryId: root.recordId,
    slotId,
    structured: data,
    findings: 'outcome' in data ? null : data.findings,
    rawAttempts: [submission({ structuredOutput: { data } })],
  })
  if ('outcome' in data) entry.payload.host.action = action
  return { root, entry }
}

function lineage(records: CanonicalRecord[]) {
  const decoded = history(records)
  return reviewContextLineage(decoded, new Map(records.map((record) => [record.recordId, record])))
}

describe('authenticated review context lineage', () => {
  it('accepts a linear negative A → negative B → positive C while preserving both negative refs', () => {
    const a = historicalReview(standaloneReviewInputs(), 'a', negative)
    const bInputs = expanded(standaloneReviewInputs(), a.entry, 'region.txt')
    const b = historicalReview(bInputs, 'b', negative)
    const cInputs = expanded(bInputs, b.entry, 'policy.txt')
    const c = historicalReview(cInputs, 'c', { findings: [] })
    expect(
      cInputs.manifest.expandedContext.filter((ref) => ref.source === 'record').map((ref) => ref.record.recordId),
    ).toEqual([a.entry.recordId, b.entry.recordId])
    const result = lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry])
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set([a.root.recordId, b.root.recordId]))
  })

  it('continues authenticated context expansion despite a foreign copied contribution identity', () => {
    const inputs = standaloneReviewInputs()
    const a = historicalReview(inputs, 'collision-a', negative)
    const bInputs = expanded(inputs, a.entry, 'region.txt')
    const b = historicalReview(bInputs, 'collision-b', { findings: [] })
    const records = [a.root, a.entry, b.root, b.entry]
    const byId = new Map(records.map((record) => [record.recordId, record]))
    const authentic = history(records)
    const foreign = observedComment({
      locator: 'foreign-collision',
      nativeId: 'foreign-collision',
      author: 'stranger',
      body: `<!-- omp-build-record v=1 kind=contribution id=${a.entry.recordId} operationId=${a.entry.operationId} part=1/2 data=e30 -->`,
    })
    const noisy = decodeHistory({ ...authentic.source, comments: [...authentic.source.comments, foreign] })
    expect(noisy.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ authority: 'foreign', operationId: a.entry.operationId })]),
    )
    const result = reviewContextLineage(noisy, byId)
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set([a.root.recordId]))
    const edited = decodeHistory({
      ...authentic.source,
      comments: authentic.source.comments.map((comment) =>
        comment.locator === `comment-${a.entry.recordId}` ? { ...comment, updatedAt: '2026-10-21T10:00:01Z' } : comment,
      ),
    })
    expect(edited.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'record-edited' })]))
    expect(reviewContextLineage(edited, byId).superseded).toEqual(new Set())
  })

  it('refuses a late final on a negative root even after a successor exists', () => {
    const a = historicalReview(standaloneReviewInputs(), 'late-a', negative)
    const b = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'region.txt'), 'late-b', negative)
    const records = [a.root, a.entry, b.root, b.entry]
    const late = finalReview({ id: 'late-final', inventoryIds: [a.root.recordId] })
    expect(lineage([...records, late]).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'incomplete',
          message: expect.stringContaining('cannot produce a final review'),
        }),
      ]),
    )
  })

  it('refuses two distinct children of the same authenticated negative', () => {
    const a = historicalReview(standaloneReviewInputs(), 'fork-a', negative)
    const b = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'one.txt'), 'fork-b', negative)
    const c = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'two.txt'), 'fork-c', negative)
    expect(lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry]).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-reference' })]),
    )
  })
})
