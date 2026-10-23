import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { FindingData, Json, NativeOutcome, Policy, Scope, Submission } from '../engine/record-values.ts'
import type { RecordProjectionConfig } from '../engine/result.ts'
import type { ReviewInputSnapshot, ReviewStandards, ReviewSubject } from '../engine/review-schema.ts'

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
