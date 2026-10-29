import {
  canonicalActionOperands,
  canonicalValueDigest,
  failedCheckEvidenceDigest,
  mechanicalSpecDelta,
  toDiagnostics,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { ActionOperands, AssessSpecExact } from '../engine/workflow-action-operands.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { type ActionFactSource, sourceRef } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import type { UwRead } from './uw-contract.ts'
import {
  type CurrentOwnSpecFacts,
  type CurrentOwnSpecFactsResult,
  readCurrentOwnSpecFacts,
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

async function observeSpecOperands(
  subject: UwSubject,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  accepted: AcceptedOwnSpec | null,
  replay?: { actionId: string; fingerprint: string },
): Promise<Result<ObservedOperands>> {
  if (accepted === null) return actionFailure('action-input-missing', 'Accepted own Spec is absent')
  const reader = createInstalledUwReadPort({
    cwd: source.cwd,
    gh: source.gh,
    readAuthor: source.readAuthor,
    ...(replay === undefined ? {} : { assessmentReplay: { uw: subject.uw, ...replay } }),
  })
  let read: UwRead
  try {
    read = await reader.readUw(subject.uw)
  } catch (error) {
    return observationError(subject, error)
  }
  if (read.graph.status !== 'complete') return { ok: false, diagnostics: toDiagnostics(read.graph.diagnostics) }
  if (
    read.accepted.status !== 'accepted' ||
    canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(accepted)
  )
    return actionFailure('review-input-changed', 'Accepted own Spec changed during current observation')
  let current: CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>
  try {
    current = await readCurrentOwnSpecFacts({ uw: subject.uw, read, reader })
  } catch (error) {
    return observationError(subject, error)
  }
  if (!current.ok) return { ok: false, diagnostics: toDiagnostics(current.diagnostics) }
  const identitySources: RecordInputRef[] = []
  for (const ref of current.value.identityAllocations) {
    const pinned = sourceRef(histories, ref)
    if (!pinned.ok) return pinned
    identitySources.push(pinned.value)
  }
  const baseline = { snapshot: accepted.snapshot, tier: accepted.tier, children: accepted.children }
  return {
    ok: true,
    value: {
      identitySources,
      operands: {
        action: 'assess-spec',
        exactInputs: {
          format: 'omp-build-spec-assessment/2',
          accepted: { ref: accepted.ref, ...baseline },
          proposed: current.value.currentSpec,
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

/** Reconstruct operands from native observations and authenticated records; the request is only an expectation. */
export async function observeActionOperands(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  accepted: AcceptedOwnSpec | null,
  replay?: { actionId: string; fingerprint: string },
): Promise<Result<{ operands?: ActionOperands; identitySources: RecordInputRef[] }>> {
  if (request.purpose !== 'assess-spec' && request.purpose !== 'attribute-ci') {
    if (request.operands !== undefined) return actionFailure('action-input-missing', 'Unexpected action operands')
    return { ok: true, value: { identitySources: [] } }
  }
  if (request.operands?.action !== request.purpose || request.subject.kind !== 'uw')
    return actionFailure('action-input-missing', 'Matching action operands and UW subject are required')
  const observed =
    request.purpose === 'assess-spec'
      ? await observeSpecOperands(request.subject, source, histories, accepted, replay)
      : await observeCiOperands(request, request.subject, source)
  if (!observed.ok) return observed
  let { operands } = observed.value
  if (canonicalActionOperands(operands) !== canonicalActionOperands(request.operands))
    return actionFailure('review-input-changed', 'Observed action operands differ from the requested comparison')
  if (operands.action === 'assess-spec' && request.operands.action === 'assess-spec') {
    operands = {
      ...operands,
      exactInputs: {
        ...operands.exactInputs,
        accepted: {
          ...preserveTimestamps(operands.exactInputs.accepted, request.operands.exactInputs.accepted),
          ref: operands.exactInputs.accepted.ref,
        },
        proposed: preserveTimestamps(operands.exactInputs.proposed, request.operands.exactInputs.proposed),
      },
    }
  }
  return { ok: true, value: { operands, identitySources: observed.value.identitySources } }
}
