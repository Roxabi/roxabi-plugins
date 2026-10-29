import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { FindingData, Json, NativeOutcome, Policy, Scope, Submission } from '../engine/record-values.ts'
import type { RecordProjectionConfig } from '../engine/result.ts'
import type { ReviewInputSnapshot, ReviewStandards, ReviewSubject } from '../engine/review-schema.ts'
import { standaloneReviewInputs } from './action-input-fixtures.ts'
export const TEST_SCOPE: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
export const NATIVE_AUTHOR = 'roxabi-bot'
export const TEST_HEAD = '1111111111111111111111111111111111111111'
export const TEST_INPUT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const BASELINE_POLICY: Policy = { version: 'baseline' }
export const SYNTHETIC_TAXONOMY = ['race-condition', 'candidate/isolated-hypothesis']

/** Projection policy is an explicit caller input; this synthetic value is only a mechanical-test fixture. */
export function projectionConfig(taxonomy: readonly string[]): RecordProjectionConfig {
  return { taxonomy, acceptedPolicy: null }
}

export const TEST_INPUT_SNAPSHOT: ReviewInputSnapshot = standaloneReviewInputs(TEST_SCOPE, TEST_HEAD)
/** Canonical review input for the default snapshot. Not the unrelated TEST_INPUT literal. */
export const TEST_REVIEW_INPUT = TEST_INPUT_SNAPSHOT.fingerprint
export const TEST_STANDARDS: ReviewStandards = {
  state: 'observed',
  rows: [{ smell: 'State persistence', assessment: 'The save path must preserve the selected region.' }],
}

type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>
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
  return { completion: 'completed', strict: 'valid', raw: null, ...overrides }
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

function reviewRootInput(options: { input?: string | null }, boundDigest: string): string | null {
  if (!('input' in options)) return boundDigest
  return options.input ?? null
}

function defaultReviewSlots(): ReviewAttempt['payload']['slots'] {
  return [
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
  ]
}

function reviewRootPayload(
  options: {
    head?: string
    input?: string | null
    slots?: ReviewAttempt['payload']['slots']
    policy?: Policy
    tier?: 'S' | 'F-lite' | 'F-full'
    replacement?: { rootAttemptId: string; dispositionId: string; grantId: string }
  },
  id: string,
  subject: ReviewSubject,
  snapshot: ReviewInputSnapshot,
  boundDigest: string,
): ReviewAttempt['payload'] {
  const payload = {
    rootAttemptId: id,
    inputFormat: 'omp-build:review-input/4' as const,
    actionInputDigest: boundDigest,
    candidateGitSHA: options.head ?? TEST_HEAD,
    input: reviewRootInput(options, boundDigest),
    slots: options.slots ?? defaultReviewSlots(),
    stage: 'initial' as const,
    purpose: 'review' as const,
    allocation: { roles: ['R-adversarial'] },
    policy: options.policy ?? BASELINE_POLICY,
  }
  if (subject.kind === 'epic-range') return { ...payload, tier: null, subject, inputSnapshot: snapshot }
  return {
    ...payload,
    tier: options.tier ?? 'S',
    subject,
    inputSnapshot: snapshot,
    ...(options.replacement !== undefined ? { replacement: options.replacement } : {}),
  }
}

export function reviewRoot(
  options: {
    id?: string
    scope?: Scope
    operationId?: string
    inputs?: string[]
    head?: string
    input?: string | null
    slots?: ReviewAttempt['payload']['slots']
    policy?: Policy
    subject?: ReviewSubject
    tier?: 'S' | 'F-lite' | 'F-full'
    inputSnapshot?: ReviewInputSnapshot
    replacement?: {
      rootAttemptId: string
      dispositionId: string
      grantId: string
    }
  } = {},
): ReviewAttempt {
  const id = options.id ?? 'root-review'
  const subject = options.subject ?? { kind: 'pull-request' as const }
  const snapshot =
    options.inputSnapshot ?? standaloneReviewInputs(options.scope ?? TEST_SCOPE, options.head ?? TEST_HEAD)
  return {
    ...(options.scope ?? TEST_SCOPE),
    ...envelope(id, options.operationId ?? `op-${id}`, options.inputs ?? []),
    kind: 'review-attempt',
    payload: reviewRootPayload(options, id, subject, snapshot, snapshot.fingerprint),
  }
}

export function synthesisInventory(
  options: {
    id?: string
    rootId?: string
    scope?: Scope
    operationId?: string
    head?: string
    input?: string | null
    actionInputDigest?: string
    policy?: Policy
  } = {},
): ReviewAttempt {
  const id = options.id ?? 'review-synthesis'
  const rootId = options.rootId ?? 'root-review'
  return {
    ...(options.scope ?? TEST_SCOPE),
    ...envelope(id, options.operationId ?? `op-${id}`, [rootId]),
    kind: 'review-attempt',
    payload: {
      rootAttemptId: rootId,
      candidateGitSHA: options.head ?? TEST_HEAD,
      inputFormat: 'omp-build:review-input/4' as const,
      actionInputDigest: options.actionInputDigest ?? TEST_REVIEW_INPUT,
      input: 'input' in options ? (options.input ?? null) : TEST_REVIEW_INPUT,
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
