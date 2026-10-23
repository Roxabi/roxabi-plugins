import { decodeHistory, encodeRecord } from '../adapters/github.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Label, Scope, Verdict } from '../engine/record-values.ts'
import type { RecordProjectionConfig } from '../engine/result.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import { NATIVE_AUTHOR, TEST_HEAD, TEST_INPUT, TEST_SCOPE } from './record-builders.ts'
import { reviewGraph } from './record-graphs.ts'
import { history, observedComment, operation } from './record-history.ts'

export function admissionReviewGraph(
  options: {
    prefix?: string
    scope?: Scope
    head?: string
    input?: string | null
    verdict?: Verdict
    comments?: ObservedComment[]
  } = {},
) {
  const verdict = options.verdict ?? 'Approve (clean)'
  const label: Label | undefined =
    verdict === 'Request changes'
      ? 'issue(blocking)'
      : verdict === 'Approve with comments'
        ? 'issue'
        : verdict === 'Approve'
          ? 'suggestion'
          : undefined
  const graph = reviewGraph({
    prefix: options.prefix ?? 'admission',
    head: options.head ?? TEST_HEAD,
    empty: verdict === 'Approve (clean)',
    label,
  })
  const scope = options.scope ?? TEST_SCOPE
  const input = 'input' in options ? (options.input ?? null) : TEST_INPUT
  const head = options.head ?? TEST_HEAD
  const records = graph.records.map((record): CanonicalRecord => {
    if (record.kind === 'review-attempt')
      return { ...record, ...scope, payload: { ...record.payload, candidateGitSHA: head, input } }
    if (record.kind === 'review')
      return { ...record, ...scope, payload: { ...record.payload, candidateGitSHA: head, input } }
    return { ...record, ...scope }
  })
  const comments =
    options.comments ??
    records.map((record, index) =>
      observedComment({
        locator: `comment-${index + 1}`,
        nativeId: String(index + 1),
        body: `<!-- omp-build:record v=1 kind=${record.kind} record=${record.recordId} operation=${record.operationId} part=1 total=1 -->`,
        createdAt: `2026-10-21T10:0${index}:00Z`,
      }),
    )
  const decoded = history(records, {
    source: { scope, expectedAuthor: NATIVE_AUTHOR, stopAuthor: null, complete: true, comments, diagnostics: [] },
    operations: records.map((record, index) => operation(record, { parts: [comments[index]] })),
  })
  return { ...graph, records, comments, history: decoded }
}

/** Produces adapter-valid native comment bodies for integration simulators. */
export function encodedAdmissionReviewGraph(
  projection: RecordProjectionConfig,
  options: { prefix?: string; scope?: Scope; head?: string; input?: string | null; verdict?: Verdict } = {},
) {
  const graph = admissionReviewGraph(options)
  const comments: ObservedComment[] = []
  let nativeId = 1
  for (const record of graph.records) {
    const source = {
      scope: graph.history.source.scope,
      expectedAuthor: NATIVE_AUTHOR,
      stopAuthor: null,
      complete: true,
      comments,
      diagnostics: [],
    }
    const encoded = encodeRecord(record, source, projection)
    if (!encoded.ok)
      throw new Error(
        `Cannot encode fixture record ${record.recordId}: ${encoded.diagnostics.map(({ code }) => code).join(', ')}`,
      )
    for (const body of encoded.value) {
      const id = String(nativeId++)
      comments.push(
        observedComment({ locator: `comment-${id}`, nativeId: id, body, createdAt: '2026-10-21T10:00:00Z' }),
      )
    }
  }
  const source = {
    scope: graph.history.source.scope,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  }
  return { ...graph, comments, history: decodeHistory(source) }
}

export function admissionReviewComments(
  projection: RecordProjectionConfig,
  options: { prefix?: string; scope?: Scope; head?: string; input?: string | null; verdict?: Verdict } = {},
): string[] {
  return encodedAdmissionReviewGraph(projection, options).comments.map((comment) => comment.body)
}
