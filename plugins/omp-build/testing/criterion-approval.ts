import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { evidenceDigest } from '../engine/criterion-admission.ts'
import { criterionEvidenceSchema } from '../engine/criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../engine/criterion-verdict-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope, Verdict } from '../engine/record-values.ts'
import type { RecordProjectionConfig } from '../engine/result.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { NATIVE_AUTHOR, submission } from './record-builders.ts'
import { contribution } from './record-decisions.ts'
import { reviewGraph } from './record-graphs.ts'
import { observedComment } from './record-history.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

/** Preserve the existing simulator comments while constructing a review fixture. */
export function criterionPullHistory(
  scope: Scope,
  comments: readonly {
    id?: number
    author: string
    body: string
    createdAt?: string | null
    updatedAt?: string | null
  }[],
) {
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `${scope.target}:comment:${comment.id ?? index + 1}`,
      nativeId: comment.id === undefined ? null : String(comment.id),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
}

/** Encode records as authenticated native comments, preserving operation order and multipart records. */
export function encodeCriterionRecords(
  records: readonly CanonicalRecord[],
  scope: Scope,
  projection: RecordProjectionConfig,
  author = NATIVE_AUTHOR,
  externalHistories: readonly DecodedHistory[] = [],
  priorHistory?: DecodedHistory,
) {
  const comments: ObservedComment[] = [...(priorHistory?.source.comments ?? [])]
  const priorCount = comments.length
  for (const record of records) {
    const source = priorHistory
      ? { ...priorHistory.source, comments }
      : { scope, expectedAuthor: author, stopAuthor: null, complete: true, comments, diagnostics: [] }
    const encoded = encodeRecord(record, source, projection, externalHistories)
    if (!encoded.ok)
      throw new Error(
        `Cannot encode fixture record ${record.recordId}: ${encoded.diagnostics.map(({ code }) => code).join(', ')}`,
      )
    for (const body of encoded.value) {
      const id = String(comments.length + 1)
      comments.push(observedComment({ locator: `comment-${id}`, nativeId: id, body, author }))
    }
  }
  const source = priorHistory
    ? { ...priorHistory.source, comments }
    : { scope, expectedAuthor: author, stopAuthor: null, complete: true, comments, diagnostics: [] }
  return { comments: comments.slice(priorCount), history: decodeHistory(source) }
}

function capturedCriterionEvidence(options: {
  mandate: MandateRecord
  inputs: ActionInputs
  head: string
  issueRecords: readonly CanonicalRecord[]
}) {
  const { mandate, inputs, head, issueRecords } = options
  if (
    inputs.manifest.spec.kind !== 'accepted' ||
    inputs.manifest.code.head !== head ||
    inputs.manifest.spec.effective.own.sourceAccepted.recordId !== mandate.recordId
  )
    throw new Error('Expected captured accepted inputs for the mandate and candidate head')
  const selection = inputs.manifest.deliveryData.find((ref) => ref.role === 'implementation')
  if (selection === undefined) throw new Error('Captured inputs contain no implementation receipt')
  const implementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' &&
      record.recordId === selection.record.recordId &&
      record.repository === selection.record.scope.repository &&
      record.target === selection.record.scope.target,
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    implementation.payload.structured === null
  )
    throw new Error('Captured implementation receipt is missing')
  const declaration = implementation.payload.structured.criteria.find(
    (item) => item.target.id === 'C1' && item.verification === 'evidence',
  )
  if (declaration === undefined || declaration.verification !== 'evidence' || declaration.evidence.length !== 1)
    throw new Error('Expected one C1 evidence declaration')
  const captured = criterionEvidenceSchema.safeParse(declaration.evidence[0])
  if (!captured.success || captured.data.method !== 'test') throw new Error('Expected captured C1 test evidence')
  const evidence = captured.data
  if (canonicalValueDigest(evidence.target.spec) !== canonicalValueDigest(inputs.manifest.spec.effective.own))
    throw new Error('Evidence does not match the captured accepted spec')
  return { selection, evidence }
}

/** Independently judge the selected fictional implementation evidence for C1. */
export function criterionSatisfiedRow(options: {
  mandate: MandateRecord
  inputs: ActionInputs
  head: string
  issueRecords: readonly CanonicalRecord[]
}) {
  const { selection, evidence } = capturedCriterionEvidence(options)
  return criterionVerdictSchema.parse({
    target: evidence.target,
    verdict: 'satisfied',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [
      {
        evidence: { receipt: selection.record, evidenceId: evidence.id, digest: evidenceDigest(evidence) },
        truth: 'supported',
        applicability: 'applies',
        codeLink: {
          method: 'test',
          after: { support: 'supported', reason: 'Captured test exercised the candidate', references: [] },
          before: null,
        },
        reason: 'The captured result satisfies the criterion',
      },
    ],
    reason: 'Independent fixture review supports C1',
  })
}

/** Bind independent spec judgment to the selected, immutable implementation evidence. */
export function criterionReviewGraph(options: {
  mandate: MandateRecord
  inputs: ActionInputs
  head: string
  issueRecords: readonly CanonicalRecord[]
  pullHistory: DecodedHistory
  issueHistory?: DecodedHistory
  scope: Scope
  projection: RecordProjectionConfig
  prefix?: string
  verdict?: Verdict
  author?: string
}) {
  const { inputs, head, issueRecords, scope, projection } = options
  const row = criterionSatisfiedRow(options)
  const verdict = options.verdict ?? 'Approve (clean)'
  const label =
    verdict === 'Request changes' ? 'issue(blocking)' : verdict === 'Approve with comments' ? 'issue' : 'suggestion'
  const graph = reviewGraph({
    prefix: options.prefix,
    scope,
    head,
    inputs,
    empty: verdict === 'Approve (clean)',
    label,
  })
  const root = {
    ...graph.root,
    payload: {
      ...graph.root.payload,
      slots: graph.root.payload.slots.map((slot) =>
        slot.slotId === 'spec-0' ? { ...slot, role: 'R-review-spec' } : slot,
      ),
    },
  }
  const specStructured = { findings: [], specRows: [row] }
  const spec = contribution({
    id: graph.spec.recordId,
    scope,
    inventoryId: graph.root.recordId,
    phase: 'spec',
    role: 'R-review-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured: specStructured,
    rawAttempts: [
      submission({ id: `child-${graph.spec.recordId}`, structuredOutput: { status: 'valid', data: specStructured } }),
    ],
  })
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected a review judgment')
  const judgment = {
    ...graph.decision.payload.judgment,
    criterionVerdicts: [{ contributionId: spec.recordId, target: row.target }],
  }
  const decision = { ...graph.decision, payload: { ...graph.decision.payload, judgment } }
  const synthesisContribution = contribution({
    id: graph.synthesisContribution.recordId,
    scope,
    inventoryId: graph.synthesis.recordId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    rawAttempts: [
      submission({
        id: `child-${graph.synthesisContribution.recordId}`,
        structuredOutput: { status: 'valid', data: judgment },
      }),
    ],
    structured: judgment,
  })
  const records: CanonicalRecord[] = [
    root,
    spec,
    graph.panel,
    graph.synthesis,
    synthesisContribution,
    decision,
    graph.review,
  ]
  const issueHistory =
    options.issueHistory ?? roxabiWorkflowFixtures().historyFrom(issueRecords, options.author ?? NATIVE_AUTHOR)
  return {
    ...graph,
    root,
    spec,
    decision,
    synthesisContribution,
    records,
    ...encodeCriterionRecords(records, scope, projection, options.author, [issueHistory], options.pullHistory),
  }
}
