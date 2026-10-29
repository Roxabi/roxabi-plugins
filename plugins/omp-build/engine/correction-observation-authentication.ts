import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { PinnedFileRef } from './action-input-schema.ts'
import type { CriterionEvidence, ObservationRef } from './criterion-evidence-schema.ts'
import { observationRefDiagnostics } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerSourceDiagnostics } from './observation-input-authentication.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

function same(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && canonicalValueDigest(left) === canonicalValueDigest(right)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function testRunsCaptured(
  evidence: Extract<CriterionEvidence, { method: 'test' }>,
  native: NonNullable<Contribution['payload']['native']>,
  actionId: string,
  childId: string,
  submissionIndex: number,
): boolean {
  const runs = [evidence.after.run, ...(evidence.before === null ? [] : [evidence.before.run])]
  return (
    evidence.provenance.kind === 'native' &&
    same(evidence.provenance, native.commandProvenance) &&
    evidence.provenance.actionId === actionId &&
    evidence.provenance.childId === childId &&
    evidence.provenance.submissionIndex === submissionIndex &&
    runs.every(
      (run) =>
        evidence.provenance.kind === 'native' &&
        evidence.provenance.toolCallIds.includes(run.toolCallId) &&
        (native.commandRuns ?? []).some((item) => same(item, run)) &&
        (native.bashCalls ?? []).some(
          (call) =>
            call.toolCallId === run.toolCallId &&
            call.result !== null &&
            call.exitCode === run.exitCode &&
            object(call.input) &&
            call.input.command === run.command,
        ),
    )
  )
}

function authenticatedSubmission(payload: Contribution['payload']): boolean {
  const native = payload.native
  const binding = payload.host.action
  const observation = native?.observation
  const submission = observation?.submission
  const raw = object(native?.raw) ? native.raw.terminal : undefined
  const output = object(raw) ? raw.structuredOutput : undefined
  const yieldRaw = submission?.raw
  const execution = object(yieldRaw) ? yieldRaw.executionArguments : undefined
  return (
    payload.host.origin === 'native' &&
    binding !== undefined &&
    validateActionInputs(binding.inputs).ok &&
    native?.completion === 'completed' &&
    native.strict === 'valid' &&
    observation !== undefined &&
    payload.host.childId === observation.childId &&
    binding.actionId === observation.actionId &&
    submission !== undefined &&
    submission.attemptIndex === observation.submissionIndex &&
    payload.rawAttempts.some((attempt) => same(attempt, submission)) &&
    object(raw) &&
    raw.id === observation.childId &&
    object(output) &&
    output.status === 'valid' &&
    same(output.data, submission.data) &&
    same(payload.structured, submission.data) &&
    object(yieldRaw) &&
    typeof yieldRaw.toolCallId === 'string' &&
    yieldRaw.toolCallId.length > 0 &&
    object(execution) &&
    same(execution.data, submission.data)
  )
}

function nativeProvenanceMatches(
  evidence: Exclude<CriterionEvidence, { method: 'test' }>,
  native: NonNullable<Contribution['payload']['native']>,
  actionId: string,
  childId: string,
  submissionIndex: number,
): boolean {
  return (
    evidence.provenance.kind === 'native' &&
    evidence.provenance.actionId === actionId &&
    evidence.provenance.childId === childId &&
    evidence.provenance.submissionIndex === submissionIndex &&
    evidence.provenance.toolCallIds.every((id) => (native.bashCalls ?? []).some((call) => call.toolCallId === id))
  )
}

function submissionContainsEvidence(criteria: unknown[], producer: unknown): boolean {
  return criteria.some(
    (declaration) =>
      object(declaration) &&
      declaration.verification === 'evidence' &&
      Array.isArray(declaration.evidence) &&
      declaration.evidence.some((item) => same(item, producer)),
  )
}

function submittedEvidence(evidence: CriterionEvidence): unknown {
  if (evidence.method !== 'test') {
    const { provenance: _provenance, ...original } = evidence
    return original
  }
  return {
    id: evidence.id,
    target: evidence.target,
    method: evidence.method,
    scenario: evidence.scenario,
    after: { toolCallId: evidence.after.run.toolCallId, versionClaim: evidence.after.versionClaim },
    before:
      evidence.before === null
        ? null
        : { toolCallId: evidence.before.run.toolCallId, versionClaim: evidence.before.versionClaim },
  }
}

export function correctionObservationAuthenticationDiagnostics(
  evidence: CriterionEvidence,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
  contribution: Contribution,
): Diagnostic[] {
  const payload = contribution.payload
  const native = payload.native
  const binding = payload.host.action
  const refs: ObservationRef[] =
    evidence.method === 'test'
      ? [...evidence.after.versionClaim.references, ...(evidence.before?.versionClaim.references ?? [])]
      : evidence.references
  const diagnostics = refs.flatMap((ref) => observationRefDiagnostics(evidence.id, ref, histories, pins))
  if (binding !== undefined) diagnostics.push(...producerSourceDiagnostics(evidence.id, refs, binding.inputs))
  const observation = native?.observation
  const submission = observation?.submission
  if (
    !authenticatedSubmission(payload) ||
    observation === undefined ||
    native === null ||
    native === undefined ||
    binding === undefined
  ) {
    diagnostics.push(diagnostic('unconfirmed', `Evidence ${evidence.id} has no authenticated correction submission`))
    return diagnostics
  }
  const data = submission?.data
  if (!object(data) || !Array.isArray(data.criteria)) {
    diagnostics.push(diagnostic('unconfirmed', `Evidence ${evidence.id} is absent from the correction submission`))
    return diagnostics
  }
  if (evidence.method === 'test') {
    if (!testRunsCaptured(evidence, native, binding.actionId, observation.childId, observation.submissionIndex))
      diagnostics.push(
        diagnostic('unconfirmed', `Evidence ${evidence.id} test runs are not in the correction host capture`),
      )
  } else if (
    !nativeProvenanceMatches(evidence, native, binding.actionId, observation.childId, observation.submissionIndex)
  ) {
    diagnostics.push(
      diagnostic('unconfirmed', `Evidence ${evidence.id} native provenance does not match the correction child`),
    )
  }
  if (!submissionContainsEvidence(data.criteria, submittedEvidence(evidence)))
    diagnostics.push(diagnostic('unconfirmed', `Evidence ${evidence.id} is absent from the correction submission`))
  return diagnostics
}
