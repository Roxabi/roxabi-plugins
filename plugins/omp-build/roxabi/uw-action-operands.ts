import {
  canonicalActionOperands,
  canonicalValueDigest,
  capturedChildOwnSources,
  failedCheckEvidenceDigest,
  mechanicalSpecDelta,
  parentCoverageSchema,
  toDiagnostics,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { ActionOperands, AssessSpecExact } from '../engine/workflow-action-operands.ts'
import type { AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { type ActionFactSource, sourceRef } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import type { UwRead } from './uw-contract.ts'
import { projectCreatedChildAssessment } from './uw-created-child-candidate.ts'
import {
  type CurrentOwnSpecFacts,
  type CurrentOwnSpecFactsResult,
  readAssessmentSpecFacts,
} from './uw-current-facts.ts'
import { createInstalledUwReadPort, UwGraphUnavailableError } from './uw-read-port.ts'

type UwSubject = Extract<UwActionRequest['subject'], { kind: 'uw' }>
type ObservedOperands = { operands: ActionOperands; identitySources: RecordInputRef[] }

function observationError(subject: UwSubject, error: unknown): Result<never> {
  if (error instanceof UwGraphUnavailableError) return { ok: false, diagnostics: toDiagnostics(error.diagnostics) }
  return actionFailure(
    'action-input-missing',
    `Current UW Spec observation for ${subject.uw.repository} ${subject.uw.target} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  )
}

async function currentAssessmentFacts(
  subject: UwSubject,
  read: UwRead,
  coverage: unknown,
  replay?: AssessmentReplayContext,
): Promise<Result<CurrentOwnSpecFacts>> {
  const proposedCoverage = parentCoverageSchema.nullable().safeParse(coverage)
  if (!proposedCoverage.success) return actionFailure('review-input-changed', 'Requested coverage is invalid')
  let current: CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>
  try {
    const assembled = await readAssessmentSpecFacts({
      uw: subject.uw,
      read,
      coverage: proposedCoverage.data,
      assessmentReplay: replay,
    })
    if (!assembled.ok && 'coverageRequest' in assembled) return actionFailure('review-input-changed', assembled.reason)
    current = assembled
  } catch (error) {
    return observationError(subject, error)
  }
  return current.ok ? current : { ok: false, diagnostics: toDiagnostics(current.diagnostics) }
}

function acceptedSpecChanged(read: UwRead, accepted: AcceptedOwnSpec): boolean {
  return (
    read.accepted.status !== 'accepted' || canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(accepted)
  )
}

async function observeSpecOperands(
  subject: UwSubject,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  accepted: AcceptedOwnSpec | null,
  coverage: unknown,
  replay?: AssessmentReplayContext,
  observedRead?: UwRead,
): Promise<Result<ObservedOperands>> {
  if (accepted === null) return actionFailure('action-input-missing', 'Accepted own Spec is absent')
  const reader = createInstalledUwReadPort({
    cwd: source.cwd,
    gh: source.gh,
    readAuthor: source.readAuthor,
    ...(replay === undefined ? {} : { assessmentReplay: replay }),
  })
  let read: UwRead
  try {
    read = observedRead ?? (await reader.readUw(subject.uw))
  } catch (error) {
    return observationError(subject, error)
  }
  if (read.graph.status !== 'complete') return { ok: false, diagnostics: toDiagnostics(read.graph.diagnostics) }
  if (acceptedSpecChanged(read, accepted))
    return actionFailure('review-input-changed', 'Accepted own Spec changed during current observation')
  if (source.createdChildAssessment !== undefined)
    return projectCreatedChildAssessment(source.createdChildAssessment, read, replay)
  const current = await currentAssessmentFacts(subject, read, coverage, replay)
  if (!current.ok) return current
  const identitySources: RecordInputRef[] = []
  for (const ref of current.value.identityAllocations) {
    const pinned = sourceRef(histories, ref)
    if (!pinned.ok) return pinned
    identitySources.push(pinned.value)
  }
  const baseline = {
    snapshot: accepted.snapshot,
    tier: accepted.tier,
    children: accepted.children,
    inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
    coverage: accepted.coverage,
  }
  const childOwnSources = capturedChildOwnSources(
    { ref: accepted.ref, ...baseline },
    current.value.currentSpec,
    histories,
    [],
    replay,
  )
  if (childOwnSources === null)
    return actionFailure('action-input-missing', 'Current child own authorities cannot be captured')
  for (const ref of childOwnSources.sourceRefs) {
    const pinned = sourceRef(histories, ref)
    if (!pinned.ok) return pinned
    identitySources.push(pinned.value)
  }
  return {
    ok: true,
    value: {
      identitySources,
      operands: {
        action: 'assess-spec',
        origin: { kind: 'native-current' },
        exactInputs: {
          format: 'omp-build-spec-assessment/3',
          accepted: { ref: accepted.ref, ...baseline },
          proposed: current.value.currentSpec,
          attachedChildren: [],
          attachedWayfinders: [],
          childOwnSources: childOwnSources.childOwnSources,
          identityAllocations: current.value.identityAllocations,
          mechanical: mechanicalSpecDelta(baseline, current.value.currentSpec),
        },
      },
    },
  }
}

async function observeCiOperands(
  request: UwActionRequest,
  subject: UwSubject,
  source: ActionFactSource,
): Promise<Result<ObservedOperands>> {
  const pull = subject.pullRequest
  if (pull === null) return actionFailure('action-input-missing', 'CI attribution requires a pull request')
  const current = await readNativeCiFailureEvidence(source.cwd, pull.repository, request.code.head, pull, {
    gh: source.gh,
    failedCheckEvidenceDigest,
  })
  if (!current.ok) return actionFailure('action-input-missing', `Current CI evidence unavailable: ${current.reason}`)
  return {
    ok: true,
    value: {
      identitySources: [],
      operands: {
        action: 'attribute-ci',
        exactInputs: {
          candidateGitSHA: request.code.head,
          scope: pull,
          failedChecks: current.failedChecks,
          evidenceDigest: current.evidenceDigest,
          failures: current.failures,
        },
      },
    },
  }
}

// Preserve descriptive timestamps while taking normative fields from the authenticated observation.
function preserveTimestamps(observed: AssessSpecExact['proposed'], expected: AssessSpecExact['proposed']) {
  return {
    ...observed,
    snapshot: {
      ...observed.snapshot,
      raw: { ...observed.snapshot.raw, lastEditedAt: expected.snapshot.raw.lastEditedAt },
    },
    children: observed.children.map((child, index) => {
      const expectedChild = expected.children[index]
      if (expectedChild === undefined) throw new TypeError('Expected child is absent')
      if ('kind' in child || 'kind' in expectedChild) {
        if (!('kind' in child) || !('kind' in expectedChild)) throw new TypeError('Expected child kind differs')
        return child
      }
      return {
        ...child,
        snapshot: {
          ...child.snapshot,
          raw: { ...child.snapshot.raw, lastEditedAt: expectedChild.snapshot.raw.lastEditedAt },
        },
      }
    }),
  }
}

function preserveOperandTimestamps(operands: ActionOperands, expected: ActionOperands): ActionOperands {
  if (operands.action !== 'assess-spec' || expected.action !== 'assess-spec') return operands
  const expectedAccepted = expected.exactInputs.accepted
  return {
    ...operands,
    exactInputs: {
      ...operands.exactInputs,
      accepted: {
        ...operands.exactInputs.accepted,
        snapshot: {
          ...operands.exactInputs.accepted.snapshot,
          raw: {
            ...operands.exactInputs.accepted.snapshot.raw,
            lastEditedAt: expectedAccepted.snapshot.raw.lastEditedAt,
          },
        },
        children: operands.exactInputs.accepted.children.map((child, index) => {
          const expectedChild = expectedAccepted.children[index]
          if (expectedChild === undefined) throw new TypeError('Expected child is absent')
          return {
            ...child,
            snapshot: {
              ...child.snapshot,
              raw: { ...child.snapshot.raw, lastEditedAt: expectedChild.snapshot.raw.lastEditedAt },
            },
          }
        }),
      },
      proposed: preserveTimestamps(operands.exactInputs.proposed, expected.exactInputs.proposed),
    },
  }
}

/** Reconstruct operands from native observations and authenticated records; the request is only an expectation. */
export async function observeActionOperands(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  accepted: AcceptedOwnSpec | null,
  replay?: { uw: Scope; actionId: string; fingerprint: string },
  observedRead?: UwRead,
): Promise<Result<{ operands?: ActionOperands; identitySources: RecordInputRef[] }>> {
  if (request.purpose === 'integrate') {
    if (request.operands?.action !== 'integrate' || request.subject.kind !== 'uw')
      return actionFailure('action-input-missing', 'Integration requires matching requested operands and a UW subject')
    return { ok: true, value: { identitySources: [] } }
  }
  if (request.purpose !== 'assess-spec' && request.purpose !== 'attribute-ci') {
    if (request.operands !== undefined) return actionFailure('action-input-missing', 'Unexpected action operands')
    return { ok: true, value: { identitySources: [] } }
  }
  if (request.operands?.action !== request.purpose || request.subject.kind !== 'uw')
    return actionFailure('action-input-missing', 'Matching action operands and UW subject are required')
  const observed =
    request.purpose === 'assess-spec'
      ? await observeSpecOperands(
          request.subject,
          source,
          histories,
          accepted,
          request.operands.action === 'assess-spec' ? request.operands.exactInputs.proposed.coverage : null,
          replay,
          observedRead,
        )
      : await observeCiOperands(request, request.subject, source)
  if (!observed.ok) return observed
  const { operands } = observed.value
  if (canonicalActionOperands(operands) !== canonicalActionOperands(request.operands))
    return actionFailure('review-input-changed', 'Observed action operands differ from the requested comparison')
  return {
    ok: true,
    value: {
      operands: preserveOperandTimestamps(operands, request.operands),
      identitySources: observed.value.identitySources,
    },
  }
}
