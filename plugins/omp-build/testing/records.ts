import { decodeHistory, encodeRecord, type RecordProjectionConfig } from '../dist/contracts.js'
import type {
  CanonicalRecord,
  Contribution,
  Decision,
  DecodedHistory,
  FindingData,
  Json,
  Label,
  NativeOutcome,
  ObservedComment,
  OperationRead,
  Policy,
  ReviewInputSnapshot,
  ReviewStandards,
  ReviewSubject,
  Scope,
  Submission,
  Verdict,
} from '../engine/schemas.ts'
import { loadReviewConfig } from '../roxabi/review-config.ts'

export const TEST_SCOPE: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
export const NATIVE_AUTHOR = 'roxabi-bot'
export const TEST_HEAD = '1111111111111111111111111111111111111111'
export const TEST_INPUT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const BASELINE_POLICY: Policy = { version: 'baseline' }
export const TEST_PROJECTION_CONFIG: RecordProjectionConfig = {
  taxonomy: loadReviewConfig().canonicalClasses,
  acceptedPolicy: null,
}

export const TEST_INPUT_SNAPSHOT: ReviewInputSnapshot = {
  body: { body: 'The selected region must remain selected after save.', lastEditedAt: '2026-10-20T09:00:00Z' },
  spec: { reference: 'SPEC-42', body: 'Persist the selected region.', lastEditedAt: null },
  semctxParts: [{ id: 17, createdAt: '2026-10-20T09:05:00Z', updatedAt: null }],
  assertledgerParts: [{ id: 8, createdAt: '2026-10-20T09:06:00Z', updatedAt: '2026-10-20T09:07:00Z' }],
}
export const TEST_STANDARDS: ReviewStandards = {
  state: 'observed',
  rows: [{ smell: 'State persistence', assessment: 'The save path must preserve the selected region.' }],
}

type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type ContributionRecord = Extract<CanonicalRecord, { kind: 'contribution' }>
type DecisionRecord = Extract<CanonicalRecord, { kind: 'decision' }>
type ReviewRecord = Extract<CanonicalRecord, { kind: 'review' }>

type Envelope = Pick<CanonicalRecord, 'version' | 'recordId' | 'runId' | 'operationId' | 'inputs'>

function envelope(recordId: string, operationId: string, inputs: string[] = []): Envelope {
  return { version: 1, recordId, runId: 'run-2026-10-21', operationId, inputs }
}

export function finding(overrides: Partial<FindingData> = {}): FindingData {
  return {
    label: 'issue',
    description: 'Widget save discards the selected region.',
    location: { file: 'src/widget.ts', line: 41 },
    rootCause: 'The save path serializes the stale region field.',
    symptomsEvidence: 'Selecting eu-west then saving stores us-east.',
    ...overrides,
  }
}

export function nativeOutcome(overrides: Partial<NativeOutcome> = {}): NativeOutcome {
  return {
    completion: 'completed',
    strict: 'valid',
    raw: { child: 'native-17', status: 'valid' },
    ...overrides,
  }
}

export function submission(
  raw: Json,
  attemptIndex = 0,
  partialText: string | null = null,
  data: Json | null = raw !== null &&
  typeof raw === 'object' &&
  !Array.isArray(raw) &&
  'structuredOutput' in raw &&
  raw.structuredOutput !== null &&
  typeof raw.structuredOutput === 'object' &&
  !Array.isArray(raw.structuredOutput) &&
  'data' in raw.structuredOutput
    ? (raw.structuredOutput.data as Json)
    : null,
): Submission {
  return { attemptIndex, data, raw, partialText }
}

export function reviewRoot(
  options: {
    id?: string
    operationId?: string
    inputs?: string[]
    head?: string
    input?: string | null
    slots?: ReviewAttempt['payload']['slots']
    policy?: Policy
    subject?: ReviewSubject
    tier?: 'S' | 'F-lite' | 'F-full'
    inputSnapshot?: ReviewInputSnapshot
  } = {},
): ReviewAttempt {
  const id = options.id ?? 'root-review'
  const subject = options.subject ?? { kind: 'pull-request' as const }
  const payload = {
    rootAttemptId: id,
    candidateGitSHA: options.head ?? TEST_HEAD,
    input: 'input' in options ? (options.input ?? null) : TEST_INPUT,
    slots: options.slots ?? [
      {
        slotId: 'spec-0',
        phase: 'spec',
        role: 'R-spec',
        chunk: null,
        required: true,
        output: 'spec',
        classId: null,
        sourceFindingIds: [],
      },
      {
        slotId: 'panel-0',
        phase: 'panel',
        role: 'R-adversarial',
        chunk: 0,
        required: true,
        output: 'findings',
        classId: null,
        sourceFindingIds: [],
      },
    ],
    stage: 'initial' as const,
    purpose: 'review' as const,
    allocation: { roles: ['R-adversarial'] },
    policy: options.policy ?? BASELINE_POLICY,
  }
  return {
    ...TEST_SCOPE,
    ...envelope(id, options.operationId ?? `op-${id}`, options.inputs ?? []),
    kind: 'review-attempt',
    payload:
      subject.kind === 'epic-range'
        ? { ...payload, tier: null, subject, inputSnapshot: null }
        : {
            ...payload,
            tier: options.tier ?? 'S',
            subject,
            inputSnapshot: options.inputSnapshot ?? TEST_INPUT_SNAPSHOT,
          },
  }
}

export function synthesisInventory(
  options: {
    id?: string
    rootId?: string
    operationId?: string
    head?: string
    input?: string | null
    policy?: Policy
  } = {},
): ReviewAttempt {
  const id = options.id ?? 'review-synthesis'
  const rootId = options.rootId ?? 'root-review'
  return {
    ...TEST_SCOPE,
    ...envelope(id, options.operationId ?? `op-${id}`, [rootId]),
    kind: 'review-attempt',
    payload: {
      rootAttemptId: rootId,
      candidateGitSHA: options.head ?? TEST_HEAD,
      input: 'input' in options ? (options.input ?? null) : TEST_INPUT,
      slots: [
        {
          slotId: 'synthesis-0',
          phase: 'synthesis',
          role: 'R-synthesis',
          chunk: null,
          required: true,
          output: 'decision',
          classId: null,
          sourceFindingIds: [],
        },
      ],
      stage: 'synthesis',
      purpose: 'review',
      policy: options.policy ?? BASELINE_POLICY,
    },
  }
}

export function contribution(
  options: {
    id?: string
    operationId?: string
    inputs?: string[]
    inventoryId?: string | null
    phase?: Contribution['host']['phase']
    role?: string | null
    slotId?: string | null
    chunk?: number | null
    content?: Contribution['content']
    findings?: Contribution['findings']
    native?: NativeOutcome | null
    rawAttempts?: Submission[]
    structured?: Json | null
  } = {},
): ContributionRecord {
  const id = options.id ?? 'panel-findings'
  const content = options.content ?? 'findings'
  const findings =
    options.findings === undefined
      ? content === 'findings'
        ? [{ id: `${id}:f0`, attemptIndex: 0, data: finding() }]
        : null
      : options.findings
  const inventoryId = options.inventoryId === undefined ? 'root-review' : options.inventoryId
  return {
    ...TEST_SCOPE,
    ...envelope(id, options.operationId ?? `op-${id}`, options.inputs ?? (inventoryId === null ? [] : [inventoryId])),
    kind: 'contribution',
    payload: {
      content,
      inventoryId,
      host: {
        origin: 'native',
        phase: options.phase === undefined ? 'panel' : options.phase,
        role: options.role === undefined ? 'R-adversarial' : options.role,
        slotId: options.slotId === undefined ? 'panel-0' : options.slotId,
        chunk: options.chunk === undefined ? 0 : options.chunk,
        childId: `child-${id}`,
      },
      rawAttempts:
        options.rawAttempts ??
        (findings === null
          ? []
          : [
              submission({
                id: `child-${id}`,
                structuredOutput: { status: 'valid', data: { findings: findings.map((original) => original.data) } },
              }),
            ]),
      native: options.native ?? nativeOutcome(),
      structured:
        'structured' in options
          ? (options.structured ?? null)
          : findings === null
            ? null
            : { findings: findings.map((original) => original.data) },
      findings,
    },
  }
}

export function decision(
  options: {
    id?: string
    operationId?: string
    inputs?: string[]
    purpose?: Decision['purpose']
    originalContributionId?: string
    sourceContributionIds?: string[]
    findings?: Decision['findings']
    policy?: Policy
    causes?: Decision['causes']
    standards?: ReviewStandards | null
  } = {},
): DecisionRecord {
  const id = options.id ?? 'review-decision'
  const sourceContributionIds = options.sourceContributionIds ?? ['panel-findings']
  const originalContributionId = options.originalContributionId ?? 'synthesis-decision'
  const purpose = options.purpose ?? 'review'
  const common = {
    policy: options.policy ?? BASELINE_POLICY,
    sourceContributionIds,
    findings: options.findings ?? [
      {
        id: 'final-finding-0',
        label: 'issue' as const,
        impactReason: 'The saved region is wrong.',
        state: 'usable' as const,
        sourceFindingIds: ['panel-findings:f0'],
        description: 'Save the selected region rather than the stale region.',
      },
    ],
    causes: options.causes ?? [],
  }
  return {
    ...TEST_SCOPE,
    ...envelope(
      id,
      options.operationId ?? `op-${id}`,
      options.inputs ?? [originalContributionId, ...sourceContributionIds],
    ),
    kind: 'decision',
    payload: {
      originalContributionId,
      // purpose first: matches decisionSchema parse order used by graph sameJson checks
      judgment:
        purpose === 'review'
          ? { purpose, ...common, standards: options.standards === undefined ? TEST_STANDARDS : options.standards }
          : { purpose, ...common },
    },
  }
}

export function finalReview(
  options: {
    id?: string
    operationId?: string
    inputs?: string[]
    head?: string
    input?: string | null
    inventoryIds?: string[]
    decisionId?: string
  } = {},
): ReviewRecord {
  const id = options.id ?? 'final-review'
  const inventoryIds = options.inventoryIds ?? ['root-review', 'review-synthesis']
  const decisionId = options.decisionId ?? 'review-decision'
  return {
    ...TEST_SCOPE,
    ...envelope(id, options.operationId ?? `op-${id}`, options.inputs ?? [...inventoryIds, decisionId]),
    kind: 'review',
    payload: {
      candidateGitSHA: options.head ?? TEST_HEAD,
      input: 'input' in options ? (options.input ?? null) : TEST_INPUT,
      inventoryIds,
      decisionId,
    },
  }
}

export function reviewGraph(options: { prefix?: string; label?: Label; head?: string; empty?: boolean } = {}) {
  const prefix = options.prefix ?? 'review'
  const rootId = `${prefix}-root`
  const synthesisId = `${prefix}-synthesis`
  const panelId = `${prefix}-panel`
  const synthesisContributionId = `${prefix}-decision-source`
  const decisionId = `${prefix}-decision`
  const reviewId = `${prefix}-final`
  const head = options.head ?? TEST_HEAD
  const root = reviewRoot({ id: rootId, head })
  const specStructured = { findings: [], specRows: [] }
  const spec = contribution({
    id: `${prefix}-spec`,
    inventoryId: rootId,
    phase: 'spec',
    role: 'R-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured: specStructured,
    rawAttempts: [
      submission({ id: `child-${prefix}-spec`, structuredOutput: { status: 'valid', data: specStructured } }),
    ],
  })
  const panelFindings = options.empty
    ? []
    : [{ id: `${panelId}:f0`, attemptIndex: 0, data: finding({ label: options.label ?? 'issue' }) }]
  const panel = contribution({ id: panelId, inventoryId: rootId, findings: panelFindings })
  const synthesis = synthesisInventory({ id: synthesisId, rootId, head })
  const reviewDecision = decision({
    id: decisionId,
    originalContributionId: synthesisContributionId,
    sourceContributionIds: [spec.recordId, panelId],
    findings: options.empty
      ? []
      : [
          {
            id: `${prefix}-finding-final`,
            label: options.label ?? 'issue',
            impactReason: 'The saved region is wrong.',
            state: 'usable',
            sourceFindingIds: [`${panelId}:f0`],
            description: 'Save the selected region rather than the stale region.',
          },
        ],
  })
  const synthesisContribution = contribution({
    id: synthesisContributionId,
    inventoryId: synthesisId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    rawAttempts: [
      submission({
        id: `child-${synthesisContributionId}`,
        structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
      }),
    ],
    structured: reviewDecision.payload.judgment,
  })
  const review = finalReview({
    id: reviewId,
    head,
    inventoryIds: [rootId, synthesisId],
    decisionId,
  })
  const records = [root, spec, panel, synthesis, synthesisContribution, reviewDecision, review] as CanonicalRecord[]
  return {
    root,
    spec,
    panel,
    synthesis,
    synthesisContribution,
    decision: reviewDecision,
    review,
    records,
    history: history(records),
  }
}

export function epicReviewGraph(options: { prefix?: string; head?: string; empty?: boolean } = {}) {
  const graph = reviewGraph({ prefix: options.prefix ?? 'epic', head: options.head, empty: options.empty })
  const root = reviewRoot({
    id: graph.root.recordId,
    head: options.head,
    subject: { kind: 'epic-range', range: `0000000000000000000000000000000000000000..${options.head ?? TEST_HEAD}` },
  })
  const reviewDecision = {
    ...graph.decision,
    payload: {
      ...graph.decision.payload,
      judgment: { ...graph.decision.payload.judgment, standards: null },
    },
  }
  const synthesisContribution = {
    ...graph.synthesisContribution,
    payload: {
      ...graph.synthesisContribution.payload,
      rawAttempts: [
        submission({
          id: `child-${graph.synthesisContribution.recordId}`,
          structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
        }),
      ],
      structured: reviewDecision.payload.judgment,
    },
  }
  const records = graph.records
    .filter((record) => record.kind !== 'review')
    .map((record) => {
      if (record.recordId === root.recordId) return root
      if (record.recordId === reviewDecision.recordId) return reviewDecision
      if (record.recordId === synthesisContribution.recordId) return synthesisContribution
      return record
    })
  return { ...graph, root, synthesisContribution, decision: reviewDecision, records, history: history(records) }
}

export function observedComment(overrides: Partial<ObservedComment> = {}): ObservedComment {
  return {
    locator: 'comment-101',
    nativeId: '101',
    body: '<!-- omp-build:record v=1 kind=review record=final-review operation=op-final-review part=1 total=1 -->',
    author: NATIVE_AUTHOR,
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: null,
    ...overrides,
  }
}

export function operation(record: CanonicalRecord, overrides: Partial<OperationRead> = {}): OperationRead {
  return {
    operationId: record.operationId,
    recordId: record.recordId,
    kind: record.kind,
    status: 'complete',
    authority: 'authority',
    claimedKinds: [record.kind],
    parts: [observedComment({ locator: `comment-${record.recordId}` })],
    record,
    ...overrides,
  }
}

export function history(records: CanonicalRecord[], overrides: Partial<DecodedHistory> = {}): DecodedHistory {
  return {
    source: {
      scope: TEST_SCOPE,
      expectedAuthor: NATIVE_AUTHOR,
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: records.map((record) => operation(record)),
    diagnostics: [],
    ...overrides,
  }
}

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
    if (record.kind === 'review-attempt') {
      return { ...record, ...scope, payload: { ...record.payload, candidateGitSHA: head, input } }
    }
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
    const encoded = encodeRecord(record, source, TEST_PROJECTION_CONFIG)
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
  options: { prefix?: string; scope?: Scope; head?: string; input?: string | null; verdict?: Verdict } = {},
): string[] {
  return encodedAdmissionReviewGraph(options).comments.map((comment) => comment.body)
}
