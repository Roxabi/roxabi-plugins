import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Contribution, Json, NativeOutcome, Policy, Submission } from '../engine/record-values.ts'
import type { Decision, ReviewStandards } from '../engine/review-schema.ts'
import {
  BASELINE_POLICY,
  finding,
  nativeOutcome,
  submission,
  TEST_HEAD,
  TEST_INPUT,
  TEST_SCOPE,
  TEST_STANDARDS,
} from './record-builders.ts'

type ContributionRecord = Extract<CanonicalRecord, { kind: 'contribution' }>
type DecisionRecord = Extract<CanonicalRecord, { kind: 'decision' }>
type ReviewRecord = Extract<CanonicalRecord, { kind: 'review' }>
type Envelope = Pick<CanonicalRecord, 'version' | 'recordId' | 'runId' | 'operationId' | 'inputs'>
type ContributionOptions = {
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
}

function defaulted<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

function contributionFindings(
  id: string,
  content: Contribution['content'],
  findings: Contribution['findings'] | undefined,
) {
  if (findings !== undefined) return findings
  return content === 'findings' ? [{ id: `${id}:f0`, attemptIndex: 0, data: finding() }] : null
}

function contributionHost(id: string, options: ContributionOptions): Contribution['host'] {
  return {
    origin: 'native',
    phase: defaulted(options.phase, 'panel'),
    role: defaulted(options.role, 'R-adversarial'),
    slotId: defaulted(options.slotId, 'panel-0'),
    chunk: defaulted(options.chunk, 0),
    childId: `child-${id}`,
  }
}

function contributionRawAttempts(id: string, findings: Contribution['findings'], supplied: Submission[] | undefined) {
  if (supplied !== undefined) return supplied
  if (findings === null) return []
  return [
    submission({
      id: `child-${id}`,
      structuredOutput: { status: 'valid', data: { findings: findings.map((original) => original.data) } },
    }),
  ]
}

function contributionStructured(options: ContributionOptions, findings: Contribution['findings']): Json | null {
  if ('structured' in options) return options.structured ?? null
  return findings === null ? null : { findings: findings.map((original) => original.data) }
}

function envelope(recordId: string, operationId: string, inputs: string[] = []): Envelope {
  return { version: 1, recordId, runId: 'run-2026-10-21', operationId, inputs }
}

export function contribution(options: ContributionOptions = {}): ContributionRecord {
  const id = options.id ?? 'panel-findings'
  const content = options.content ?? 'findings'
  const findings = contributionFindings(id, content, options.findings)
  const inventoryId = defaulted(options.inventoryId, 'root-review')
  return {
    ...TEST_SCOPE,
    ...envelope(id, options.operationId ?? `op-${id}`, options.inputs ?? (inventoryId === null ? [] : [inventoryId])),
    kind: 'contribution',
    payload: {
      content,
      inventoryId,
      host: contributionHost(id, options),
      rawAttempts: contributionRawAttempts(id, findings, options.rawAttempts),
      native: options.native ?? nativeOutcome(),
      structured: contributionStructured(options, findings),
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
