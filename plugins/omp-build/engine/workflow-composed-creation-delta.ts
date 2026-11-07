import type { CauseCreationProposal, ComposedParentConsent } from './cause-disposition-schema.ts'
import { equalScope, sameOwnSpecRef } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { type UwNativeNode, validateUwGraph } from './uw-graph.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { ComposedCreationEffects, type CreationDeltaInput } from './workflow-composed-creation-effects.ts'
import { buildComposedMaterialAcceptanceControl } from './workflow-composed-material.ts'
import {
  compositionStale,
  issueFromScope,
  type NativeObservationReader,
  sameObservationValue,
} from './workflow-composed-observation.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import { recheckMaterialAcceptance } from './workflow-material-acceptance.ts'

type Intent = { outer: CauseCreationProposal; consent: ComposedParentConsent }
type Control = Extract<CanonicalRecord, { kind: 'operator-control' }>

function confirmedCreationIntent(input: CreationDeltaInput): Result<Intent> {
  const { before, after, operation } = input
  const priorIntentHistory = historyFor(operation.scope, before.histories)
  if (
    priorIntentHistory === null ||
    priorIntentHistory.operations.some((entry) => entry.recordId === operation.recordId)
  )
    return compositionStale(
      'Creation intent scope was not observed before confirmation or its operation already existed',
    )
  const intentHistory = historyFor(operation.scope, after.histories)
  const intent = intentHistory === null ? null : bindExternalRef(operation, intentHistory)
  if (
    intent === null ||
    !intent.ok ||
    intent.value.kind !== 'cause-operation' ||
    intent.value.payload.proposal.operation !== 'create'
  )
    return compositionStale('Confirmed creation intent is unavailable')
  const outer = intent.value.payload.proposal
  const consent = outer.parentAcceptance
  if (consent === null) return compositionStale('Confirmed creation intent is unavailable')
  return { ok: true, value: { outer, consent } }
}

function originalParentObservation(
  input: CreationDeltaInput,
  consent: ComposedParentConsent,
  native: NativeObservationReader,
): Result<{ beforeNative: NativeIssueObservation; afterNode: UwNativeNode | undefined }> {
  const beforeHistory = historyFor(consent.parent, input.before.histories)
  const beforeNode = input.before.graph.nodes.find((node) => equalScope(node.uw, consent.parent))
  const afterNode = input.after.graph.nodes.find((node) => equalScope(node.uw, consent.parent))
  const beforeNative = beforeNode === undefined ? null : native(beforeNode)
  const afterNative = afterNode === undefined ? null : native(afterNode)
  if (
    beforeHistory === null ||
    beforeNative === null ||
    afterNative === null ||
    specDigest(JSON.stringify(beforeHistory)) !== consent.historyDigest ||
    nativeObservationDigest(beforeNative) !== consent.nativeObservationDigest
  )
    return compositionStale('Original parent observation does not match the confirmed consent')
  return { ok: true, value: { beforeNative, afterNode } }
}

function currentParentControl(input: CreationDeltaInput, consent: ComposedParentConsent): Result<Control> {
  const { after, prepared, operation, binding } = input
  const parentMandateHistory = historyFor(consent.mandate.scope, after.histories)
  if (parentMandateHistory === null) return compositionStale('Parent mandate history is unavailable')
  const mandate = bindExternalRef(consent.mandate, parentMandateHistory)
  if (!mandate.ok || mandate.value.kind !== 'mandate') return compositionStale('Parent mandate cannot be authenticated')
  const selected = selectedMandate(parentMandateHistory)
  if (!('kind' in selected) || selected.kind !== 'mandate' || selected.recordId !== mandate.value.recordId)
    return compositionStale('Parent mandate is no longer the uniquely active mandate')
  const checked = recheckMaterialAcceptance({ prepared, histories: after.histories, mandate: selected })
  if (!checked.ok) return checked
  const current = resolveAcceptedSpec(mandate.value, after.histories)
  if (!current.ok || !sameOwnSpecRef(current.spec.ref, consent.accepted))
    return compositionStale('Parent accepted predecessor advanced during creation')
  return buildComposedMaterialAcceptanceControl({ prepared, operation, binding, histories: after.histories })
}

export function checkParentCreationDelta(input: CreationDeltaInput, native: NativeObservationReader): Result<Control> {
  const { before, after, binding } = input
  if (before.status !== 'complete' || after.status !== 'complete')
    return compositionStale('Both parent observation cuts must be complete')
  if (!validateUwGraph(before.graph).ok || !validateUwGraph(after.graph).ok)
    return compositionStale('Creation native graph is incomplete or invalid')
  const intent = confirmedCreationIntent(input)
  if (!intent.ok) return intent
  const { outer, consent } = intent.value
  const parent = originalParentObservation(input, consent, native)
  if (!parent.ok) return parent
  const effects = new ComposedCreationEffects(input, native)
  const historyProblem = effects.historyProblem()
  if (historyProblem !== null) return compositionStale(historyProblem)
  const childIssue = issueFromScope(binding.child)
  if (childIssue === null || parent.value.beforeNative.children.some((item) => sameObservationValue(item, childIssue)))
    return compositionStale('Created child is not a new positive issue')
  const graphProblem = effects.graphProblem(outer, consent, childIssue)
  if (graphProblem !== null) return compositionStale(graphProblem)
  const childrenProblem = effects.parentChildrenProblem(parent.value.afterNode)
  if (childrenProblem !== null) return compositionStale(childrenProblem)
  const nativeProblem = effects.newNativeProblem()
  return nativeProblem === null ? currentParentControl(input, consent) : compositionStale(nativeProblem)
}
