import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputManifest } from '../action-input-schema.ts'
import { canonicalValueDigest } from '../canonical-value.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { MandateRecord, ReceiptRecord } from '../workflow-control.ts'
import { hostInterruptionDiagnostic } from '../workflow-interruption-proof.ts'
import type { WorkflowDecision } from '../workflow-reconstruction-types.ts'

/** Proposal format the engine digests: the resolution payload minus proposalDigest and confirmation. */
export const INTERRUPTION_RESOLUTION_FORMAT = 'omp-build-interruption-resolution/2'
export const INTERRUPTED_NATIVE = { completion: 'incomplete', strict: 'absent', raw: null } as const
export const STOP_DIAGNOSTIC = hostInterruptionDiagnostic('session-stop')
export const RESOLVED_AT = '2026-10-21T12:00:00.000Z'

/**
 * A hand-built record shape for admissible records and deliberate schema violations.
 * The real codec remains responsible for admitting or refusing it.
 */
export type PlannedRecord = {
  version: 1
  recordId: string
  runId: string
  operationId: string
  repository: string
  target: string
  kind: string
  inputs: string[]
  payload: Record<string, unknown>
}

export function refOf(record: CanonicalRecord | PlannedRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind as ExternalRecordRef['kind'],
  }
}

export function receiptOf(record: CanonicalRecord | undefined): ReceiptRecord {
  if (record?.kind !== 'action-receipt') throw new Error('Expected an action receipt fixture')
  return record
}

export function pairOf(records: readonly CanonicalRecord[]): [ReceiptRecord, ReceiptRecord] {
  if (records.length !== 2) throw new Error('Expected one START and one RESULT')
  return [receiptOf(records[0]), receiptOf(records[1])]
}

function reparsed(record: CanonicalRecord, changes: Record<string, unknown>): CanonicalRecord {
  const parsed = parseRecord({ ...record, ...changes })
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
  return parsed.value
}

/** Honest incomplete RESULT as published by the host after a session stop: no output, no admitted effects. */
export function interruptedResult(result: ReceiptRecord, overrides: Record<string, unknown> = {}): ReceiptRecord {
  if (result.payload.phase !== 'result') throw new Error('Expected a RESULT fixture')
  return receiptOf(
    reparsed(result, {
      payload: {
        ...result.payload,
        native: INTERRUPTED_NATIVE,
        structured: null,
        diagnostics: [STOP_DIAGNOSTIC],
        ...overrides,
      },
    }),
  )
}

export function withPayload(record: ReceiptRecord, changes: Record<string, unknown>, recordId = record.recordId) {
  return receiptOf(
    reparsed(record, {
      recordId,
      operationId: `op-${recordId}`,
      payload: { ...record.payload, ...changes },
    }),
  )
}

export const INTERRUPTED_IMPLEMENTATION_ADMISSION = {
  admitted: false,
  commits: [],
  paths: [],
  commands: [],
  remoteBranch: null,
  remoteTip: null,
  published: false,
  reason: 'action-interrupted',
} as const

export function resumeOf(mandate: MandateRecord, confirmation: CanonicalRecord, controlId = 'control-pause-1') {
  const built = buildRecord({
    version: 1,
    recordId: `${controlId}-resumed`,
    runId: mandate.runId,
    operationId: `op-${controlId}-resumed`,
    repository: mandate.repository,
    target: mandate.target,
    kind: 'operator-control',
    payload: {
      control: 'resume',
      predecessor: refOf(confirmation),
      controlId,
      mandate: { ...refOf(mandate), kind: 'mandate' },
    },
  })
  if (!built.ok) throw new Error(built.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
  return built.value
}

export type ResolutionInput = {
  mandate: MandateRecord
  /** The confirmed pause this neutral resolution was published under; never consumed by it. */
  pause: CanonicalRecord
  start: ReceiptRecord | PlannedRecord
  result: ReceiptRecord | PlannedRecord | null
  legacyV1?: boolean
  effects?: Record<string, unknown>
  adopted?: CanonicalRecord | PlannedRecord | null
  executor?: Record<string, unknown>
  /** Mutates the proposal before the digest is computed (a self-consistent but semantically wrong resolution). */
  proposal?: (proposal: Record<string, unknown>) => Record<string, unknown>
  /** Mutates the confirmed payload after the digest is computed (a forged resolution). */
  payload?: (payload: Record<string, unknown>) => Record<string, unknown>
  recordId?: string
  operationId?: string
}

function receiptIdentity(start: ReceiptRecord | PlannedRecord): { action: unknown; actionId: unknown } {
  const payload = start.payload as Record<string, unknown>
  return { action: payload.action, actionId: payload.actionId }
}

function isRef(value: unknown): value is ExternalRecordRef {
  return typeof value === 'object' && value !== null && 'recordId' in value && 'scope' in value
}

/** The planned `resolve-interruption` operator control, published in the START's scope. */
export function interruptionResolution(input: ResolutionInput): PlannedRecord {
  const operationId = input.operationId ?? `op-resolve-${input.start.recordId}`
  const config = input.mandate.payload.config
  const identity = receiptIdentity(input.start)
  const draft: Record<string, unknown> = {
    control: 'resolve-interruption',
    controlId: operationId,
    mandate: { ...refOf(input.mandate), kind: 'mandate' },
    predecessor: refOf(input.pause),
    action: identity.action,
    actionId: identity.actionId,
    start: refOf(input.start),
    result: input.result === null ? null : refOf(input.result),
    ...(input.legacyV1
      ? {
          adopted: input.adopted ?? null,
          executor: input.executor ?? { kind: 'host-settled' },
          effects: input.effects ?? { kind: 'none' },
        }
      : {
          executor: input.executor ?? { kind: 'not-dispatched' },
          ...(input.effects === undefined ? {} : { effects: input.effects }),
          ...(input.adopted === undefined ? {} : { adopted: input.adopted }),
        }),
    runtime: { productVersion: config.productVersion, configVersion: config.version, configDigest: config.digest },
  }
  const proposal = input.proposal?.(draft) ?? draft
  const proposalDigest = canonicalValueDigest({
    format: input.legacyV1 ? 'omp-build-interruption-resolution/1' : INTERRUPTION_RESOLUTION_FORMAT,
    ...proposal,
  })
  const confirmed: Record<string, unknown> = {
    ...proposal,
    proposalDigest,
    confirmation: { route: 'omp-native-command', operationId, proposalDigest, confirmedAt: RESOLVED_AT },
  }
  const payload = input.payload?.(confirmed) ?? confirmed
  const scope = { repository: input.start.repository, target: input.start.target }
  const inputs = [payload.mandate, payload.predecessor, payload.start, payload.result, payload.adopted]
    .filter(isRef)
    .filter((ref) => ref.scope.repository === scope.repository && ref.scope.target === scope.target)
    .map((ref) => ref.recordId)
  return {
    version: 1,
    recordId: input.recordId ?? `interruption-resolution-${input.start.recordId}`,
    runId: input.mandate.runId,
    operationId,
    repository: scope.repository,
    target: scope.target,
    kind: 'operator-control',
    inputs: [...new Set(inputs)],
    payload,
  }
}

/** Seals the exact adopted resolution into an implementation START as delivery role `implementation-recovery`. */
export function recoveryStart(start: ReceiptRecord, head: string, recovery: PlannedRecord): PlannedRecord {
  const inputs = start.payload.inputs
  const manifest = {
    ...inputs.manifest,
    code: { ...inputs.manifest.code, head },
    deliveryData: [
      ...inputs.manifest.deliveryData,
      {
        source: 'record',
        record: refOf(recovery),
        selector: '/payload',
        digest: canonicalValueDigest(recovery.payload),
        role: 'implementation-recovery',
      },
    ],
  }
  return {
    version: 1,
    recordId: start.recordId,
    runId: start.runId,
    operationId: start.operationId,
    repository: start.repository,
    target: start.target,
    kind: start.kind,
    inputs: [...start.inputs],
    payload: {
      ...start.payload,
      inputs: {
        ...inputs,
        manifest,
        fingerprint: actionInputDigest(manifest as unknown as ActionInputManifest),
      },
    },
  }
}

/**
 * Frames admitted records in canonical schema order, like the host encoder. Invalid records stay
 * verbatim so the decoder, not the fixture, decides their admissibility.
 */
export function appendRecords(
  history: DecodedHistory,
  records: readonly (CanonicalRecord | PlannedRecord)[],
): DecodedHistory {
  const comments = [...history.source.comments]
  let next = Math.max(0, ...comments.map((comment) => Number(comment.nativeId) || 0))
  for (const record of records) {
    const canonical = parseRecord(record)
    const framed = canonical.ok ? canonical.value : (record as unknown as CanonicalRecord)
    const parts = encodeParts(framed, `# ${record.kind}`, 65_536)
    if (!parts.ok) throw new Error(parts.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '))
    for (const body of parts.value) {
      next += 1
      const nativeId = String(next)
      comments.push({
        locator: `${history.source.scope.target}:comment:${nativeId}`,
        nativeId,
        body,
        author: history.source.expectedAuthor,
        createdAt: '2026-10-21T12:00:00Z',
        updatedAt: '2026-10-21T12:00:00Z',
      })
    }
  }
  return decodeHistory({ ...history.source, comments })
}

export function evidenceCodes(decision: WorkflowDecision): string[] {
  return decision.evidence.map((entry) => entry.code)
}
