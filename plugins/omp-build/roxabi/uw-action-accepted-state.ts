import {
  historyFor,
  resolveAcceptedSpec,
  resolveSpecEffective,
  selectWorkflowBinding,
  type UwGraphObservation,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { ActionInputManifest, ActionSubject, RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { pinAcceptedSources, sourceRef } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'

const ACCEPTED_PURPOSE: Record<string, true> = {
  plan: true,
  'plan-review': true,
  implement: true,
  integrate: true,
  'attribute-ci': true,
  review: true,
  correction: true,
}

function bindSubject(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  histories: readonly DecodedHistory[],
  observed: { branch: string; baseName: string },
): Result<{ subject: ActionSubject; mandate: ReturnType<typeof currentAccountedMandate> }> {
  const pull = subject.pullRequest
  let bound: ActionSubject = subject
  const issueHistory = historyFor(subject.uw, histories)
  const mandate =
    issueHistory === null
      ? actionFailure('action-input-missing', 'UW history is absent')
      : currentAccountedMandate(issueHistory)
  if (ACCEPTED_PURPOSE[request.purpose] && !mandate.ok) return mandate
  if (pull === null) return { ok: true, value: { subject, mandate } }
  const selected = selectWorkflowBinding({
    pullRequest: pull,
    histories,
    native: { branch: observed.branch, base: observed.baseName },
  })
  if (selected.status !== 'bound') {
    if (ACCEPTED_PURPOSE[request.purpose])
      return actionFailure('action-input-missing', 'No current approved workflow binding')
    return { ok: true, value: { subject, mandate } }
  }
  if (
    mandate.ok &&
    (selected.mandateRecord.repository !== mandate.value.repository ||
      selected.mandateRecord.target !== mandate.value.target ||
      selected.mandateRecord.recordId !== mandate.value.recordId)
  ) {
    return actionFailure('action-input-cycle', 'Pull request binding is not the current accounted mandate')
  }
  const binding = sourceRef(histories, { scope: pull, recordId: selected.binding.recordId, kind: 'workflow-binding' })
  if (!binding.ok) return binding
  bound = { kind: 'uw', uw: subject.uw, pullRequest: pull, binding: binding.value }
  return { ok: true, value: { subject: bound, mandate } }
}

function acceptedChain(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  mandate: Result<import('../engine/workflow-control.ts').MandateRecord>,
  config: ActionInputManifest['configuration'],
  graph: UwGraphObservation,
  replay?: AssessmentReplayContext,
): Result<{
  spec: ActionInputManifest['spec']
  acceptedSources: RecordInputRef[]
  configuration: ActionInputManifest['configuration']
  acceptedSpec: AcceptedOwnSpec | null
}> {
  const spec: ActionInputManifest['spec'] = { kind: 'absent', reason: 'standalone-review' }
  const acceptedSources: RecordInputRef[] = []
  if (!mandate.ok || (!ACCEPTED_PURPOSE[request.purpose] && request.purpose !== 'assess-spec'))
    return request.purpose === 'assess-spec'
      ? actionFailure('action-input-missing', 'Assessment requires the current accounted mandate')
      : { ok: true, value: { spec, acceptedSources, configuration: config, acceptedSpec: null } }
  const accepted = resolveAcceptedSpec(mandate.value, histories, replay)
  if (!accepted.ok) return { ok: false, diagnostics: accepted.evidence }
  const effective =
    request.purpose === 'assess-spec'
      ? resolveSpecEffective({
          mode: 'historical',
          own: accepted.spec.ref,
          versionVector: [accepted.spec.ref, ...accepted.spec.inheritedOwnSpecRefs],
          histories,
          assessmentReplay: replay,
        })
      : resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories, graph })
  if (!effective.ok) return { ok: false, diagnostics: effective.diagnostics }
  const pinned = pinAcceptedSources(histories, [
    ...accepted.spec.sourceRefs,
    ...effective.value.versionVector.map((ref) => ref.sourceAccepted),
  ])
  if (!pinned.ok) return pinned
  return {
    ok: true,
    value: {
      spec: { kind: 'accepted', effective: effective.value },
      acceptedSources: pinned.value,
      acceptedSpec: accepted.spec,
      configuration: {
        version: mandate.value.payload.config.version,
        digest: mandate.value.payload.config.digest,
        serialized: JSON.stringify(mandate.value.payload.config.effective),
      },
    },
  }
}

export { ACCEPTED_PURPOSE, acceptedChain, bindSubject }
